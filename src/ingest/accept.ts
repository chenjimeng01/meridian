// Accept flow (SPEC §5.6): only operator-accepted parse lines enter the
// ledger, every entry traceable to its source document. This module applies an
// accepted run to the ledger; the CLI (Phase 4) drives per-line decisions.
// Object key order is fixed throughout — ledger serialization is byte-stable.
import type { IdFactory, Ledger, ParseHolding, ParseRun } from "./types.ts";

export interface HouseholdConfig {
  base_currency: string;
  secondary_currency?: string;
  persons: { token: string; names: string[]; tax_profile: Record<string, unknown> }[];
  addresses?: string[];
  account_owners?: Record<string, string[]>;
}

const US_WRAPPERS = new Set(["us_brokerage", "ira_trad", "ira_roth", "401k", "529"]);

const TYPE_RULES: [RegExp, string][] = [
  [/money market/i, "mmf"],
  [/ucits etf/i, "ucits_etf"],
  [/\betf\b/i, "us_etf"],
  [/oeic/i, "oeic"],
  [/gilt|treasury .*\d+(\.\d+)?%/i, "bond"],
  [/investment trust/i, "investment_trust"],
  [/plc|ordinary|common stock/i, "equity"],
];

function inferType(holding: ParseHolding): string {
  for (const [re, type] of TYPE_RULES) if (re.test(holding.name)) return type;
  if (/fund/i.test(holding.name)) {
    return holding.identifiers.isin?.startsWith("US") ? "mutual_fund_us" : "other_pooled";
  }
  return "other_pooled";
}

export function initHousehold(config: HouseholdConfig, ids: IdFactory): Ledger {
  return {
    schema_version: "0.1",
    household: {
      id: ids(),
      base_currency: config.base_currency,
      ...(config.secondary_currency ? { secondary_currency: config.secondary_currency } : {}),
      persons: config.persons.map((p) => ({
        id: ids(),
        display_token: p.token,
        tax_profile: p.tax_profile,
      })),
    },
    accounts: [],
    instruments: [],
    holdings: [],
    transactions: [],
    documents: [],
    fx_rates: [],
  };
}

// Resolve at accept time against the live ledger: two accounts in one document
// can hold the same (not yet known) instrument, so an identifier lookup must
// see drafts created moments earlier in this same run.
function resolveInstrument(ledger: Ledger, holding: ParseHolding, ids: IdFactory): string {
  const idn = holding.identifiers ?? {};
  const exact = ledger.instruments.find(
    (inst) =>
      (idn.isin && inst.identifiers.isin === idn.isin) ||
      (idn.sedol && inst.identifiers.sedol === idn.sedol) ||
      (idn.cusip && inst.identifiers.cusip === idn.cusip)
  );
  if (exact) return exact.id;
  const draft = {
    id: ids(),
    identifiers: idn,
    name: holding.name,
    type: inferType(holding),
    ...(idn.isin ? { domicile: idn.isin.slice(0, 2) } : {}),
    pfic_status: "not_assessed",
    needs_review: true,
    prices: [],
  };
  ledger.instruments.push(draft);
  return draft.id;
}

function cashInstrument(ledger: Ledger, currency: string, ids: IdFactory): string {
  const name = `Cash (${currency})`;
  const existing = ledger.instruments.find((i) => i.type === "cash" && i.name === name);
  if (existing) return existing.id;
  const created = {
    id: ids(),
    identifiers: {},
    name,
    type: "cash",
    pfic_status: "not_assessed",
    prices: [],
  };
  ledger.instruments.push(created);
  return created.id;
}

export function acceptRun(ledger: Ledger, run: ParseRun, config: HouseholdConfig, ids: IdFactory): void {
  const src = run.output.source;
  const docId = ids();
  const personIdByToken = new Map(ledger.household.persons.map((p) => [p.display_token, p.id]));

  ledger.documents.push({
    id: docId,
    filename: run.filename,
    sha256: run.sha256,
    institution: src.institution,
    doc_type: src.doc_type,
    period: src.period,
    parse_run_ids: [run.id],
  });

  for (const fx of src.fx_rates ?? []) {
    ledger.fx_rates.push({
      date: fx.date ?? src.period.to,
      pair: fx.pair,
      rate: fx.rate,
      source: `statement:${run.filename.replace(/\.txt$/, "")}`,
    });
  }

  for (const acct of run.output.accounts) {
    let account = ledger.accounts.find((a) => a.account_token === acct.account_token);
    if (!account) {
      const wrapper = acct.wrapper_hint && acct.wrapper_hint !== "unknown" ? acct.wrapper_hint : "gia";
      const ownerTokens = config.account_owners?.[acct.account_token] ?? [config.persons[0]!.token];
      account = {
        id: ids(),
        person_ids: ownerTokens.map((t) => personIdByToken.get(t)!),
        institution: src.institution,
        account_token: acct.account_token,
        wrapper,
        wrapper_jurisdiction: US_WRAPPERS.has(wrapper) ? "US" : "UK",
        custody_currency: acct.currency ?? src.statement_currency,
        opened: null,
        data_asof: src.period.to,
      };
      ledger.accounts.push(account);
    }

    for (const holding of acct.holdings ?? []) {
      const instrumentId = resolveInstrument(ledger, holding, ids);
      ledger.holdings.push({
        account_id: account.id,
        instrument_id: instrumentId,
        asof: src.period.to,
        units: holding.units,
        value: holding.value,
        source_document_id: docId,
      });
      if (holding.price) {
        const instrument = ledger.instruments.find((i) => i.id === instrumentId)!;
        instrument.prices.push({ date: src.period.to, price: holding.price, source: "statement" });
      }
    }

    if (acct.cash_balance) {
      ledger.holdings.push({
        account_id: account.id,
        instrument_id: cashInstrument(ledger, acct.cash_balance.currency, ids),
        asof: src.period.to,
        units: acct.cash_balance.amount,
        value: acct.cash_balance,
        source_document_id: docId,
      });
    }

    for (const fee of acct.fees ?? []) {
      ledger.transactions.push({
        account_id: account.id,
        date: fee.period?.to ?? src.period.to,
        type: "fee",
        instrument_id: null,
        gross: fee.amount,
        net: fee.amount,
        source_document_id: docId,
      });
    }

    for (const move of acct.movements ?? []) {
      ledger.transactions.push({
        account_id: account.id,
        date: move.date,
        type: move.type,
        instrument_id: null,
        gross: move.amount,
        net: move.amount,
        source_document_id: docId,
      });
    }

    if ((acct.holdings?.length || acct.cash_balance) && src.period.to > account.data_asof) {
      account.data_asof = src.period.to;
    }
  }
}

export function serializeLedger(ledger: Ledger): string {
  return JSON.stringify(ledger, null, 2) + "\n";
}
