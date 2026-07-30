// Accept flow (SPEC §5.6): the operator accepts, edits or rejects every
// extracted line; ONLY accepted lines enter the ledger, and every decision is
// written to an append-only acceptance log with an injected timestamp.
// Object key order is fixed throughout — ledger serialization is byte-stable.
import type {
  AcceptOptions,
  AcceptanceLine,
  IdFactory,
  Ledger,
  LineDecision,
  LineRef,
  MatchResult,
  Money,
  ParseHolding,
  ParseRun,
  TaxProfile,
  Instrument,
} from "./types.ts";

export interface HouseholdConfig {
  base_currency: string;
  secondary_currency?: string;
  persons: { token: string; names: string[]; tax_profile: TaxProfile }[];
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

const ACCEPT_ALL: (line: LineRef) => LineDecision = () => ({ action: "accept" });

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
    acceptances: [],
    fx_rates: [],
  };
}

function hasIdentifier(holding: ParseHolding): boolean {
  const idn = holding.identifiers ?? {};
  return Boolean(idn.isin || idn.sedol || idn.cusip);
}

function findByIdentifier(ledger: Ledger, holding: ParseHolding): string | undefined {
  const idn = holding.identifiers ?? {};
  return ledger.instruments.find(
    (inst) =>
      (idn.isin && inst.identifiers.isin === idn.isin) ||
      (idn.sedol && inst.identifiers.sedol === idn.sedol) ||
      (idn.cusip && inst.identifiers.cusip === idn.cusip)
  )?.id;
}

function createDraft(ledger: Ledger, holding: ParseHolding, ids: IdFactory): string {
  const idn = holding.identifiers ?? {};
  const draft: Instrument = {
    id: ids(),
    identifiers: idn,
    name: holding.name,
    type: inferType(holding),
    ...(idn.isin ? { domicile: idn.isin.slice(0, 2) } : {}),
    pfic_status: "not_assessed" as const,
    // SPEC §5.4 reserves needs_review for instruments that could not be
    // resolved by identifier — a clean ISIN match is not "unknown".
    ...(hasIdentifier(holding) ? {} : { needs_review: true }),
    prices: [],
  };
  ledger.instruments.push(draft);
  return draft.id;
}

// Resolution order (SPEC §5.4): the operator's confirmed candidate wins; then a
// deterministic identifier match against the live ledger (which includes drafts
// created moments ago in this same run); otherwise a new draft.
function resolveInstrument(
  ledger: Ledger,
  holding: ParseHolding,
  decision: LineDecision,
  match: MatchResult | undefined,
  ids: IdFactory
): string {
  if (decision.instrumentId) {
    const confirmed = ledger.instruments.find((i) => i.id === decision.instrumentId);
    if (!confirmed) {
      throw new Error(
        `accept: confirmed instrument ${decision.instrumentId} for "${holding.name}" is not in the ledger`
      );
    }
    // A confirmed fuzzy match may carry identifiers the ledger lacked.
    const identifierKeys = ["isin", "sedol", "ticker", "cusip"] as const;
    for (const key of identifierKeys) {
      const value = holding.identifiers?.[key];
      if (value && !confirmed.identifiers[key]) confirmed.identifiers[key] = value;
    }
    if (confirmed.needs_review && hasIdentifier(holding)) delete confirmed.needs_review;
    return confirmed.id;
  }
  const byIdentifier = findByIdentifier(ledger, holding);
  if (byIdentifier) return byIdentifier;
  if (match?.status === "matched" && match.instrumentId) return match.instrumentId;
  return createDraft(ledger, holding, ids);
}

function cashInstrument(ledger: Ledger, currency: string, ids: IdFactory): string {
  const name = `Cash (${currency})`;
  const existing = ledger.instruments.find((i) => i.type === "cash" && i.name === name);
  if (existing) return existing.id;
  const created: Instrument = {
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

const outcome = (decision: LineDecision): AcceptanceLine["action"] =>
  decision.action === "reject" ? "rejected" : decision.edits ? "edited" : "accepted";

export function acceptRun(
  ledger: Ledger,
  run: ParseRun,
  config: HouseholdConfig,
  ids: IdFactory,
  options: AcceptOptions
): void {
  const decide = options.decide ?? ACCEPT_ALL;
  const src = run.output.source;
  const docId = ids();
  const personIdByToken = new Map(ledger.household.persons.map((p) => [p.display_token, p.id]));
  const log: AcceptanceLine[] = [];

  ledger.documents.push({
    id: docId,
    filename: run.filename,
    sha256: run.sha256,
    institution: src.institution,
    doc_type: src.doc_type,
    period: src.period,
    parsed_at: run.created_at,
    accepted_at: options.acceptedAt,
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

  run.output.accounts.forEach((acct, accountIndex) => {
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
      log.push({ kind: "account", account_token: acct.account_token, ref: `${wrapper} at ${src.institution}`, action: "accepted" });
    }

    let entered = false;

    (acct.holdings ?? []).forEach((holding, index) => {
      const match = run.matches.find((m) => m.accountIndex === accountIndex && m.holdingIndex === index);
      const decision = decide({
        kind: "holding",
        accountToken: acct.account_token,
        index,
        ref: holding.name,
        ...(match ? { match } : {}),
        holding,
      });
      const action = outcome(decision);
      if (decision.action === "reject") {
        log.push({ kind: "holding", account_token: acct.account_token, ref: holding.name, action, ...(decision.note ? { note: decision.note } : {}) });
        return;
      }
      const instrumentId = resolveInstrument(ledger, holding, decision, match, ids);
      const units = decision.edits?.units ?? holding.units;
      const value = decision.edits?.value ?? holding.value;
      ledger.holdings.push({
        account_id: account!.id,
        instrument_id: instrumentId,
        asof: src.period.to,
        units,
        value,
        source_document_id: docId,
      });
      if (holding.price) {
        const instrument = ledger.instruments.find((i) => i.id === instrumentId)!;
        instrument.prices.push({ date: src.period.to, price: holding.price, source: "statement" });
      }
      entered = true;
      log.push({
        kind: "holding",
        account_token: acct.account_token,
        ref: holding.name,
        action,
        instrument_id: instrumentId,
        ...(decision.note ? { note: decision.note } : {}),
      });
    });

    if (acct.cash_balance) {
      const decision = decide({
        kind: "cash",
        accountToken: acct.account_token,
        index: 0,
        ref: `Cash (${acct.cash_balance.currency})`,
        cash: acct.cash_balance,
      });
      const action = outcome(decision);
      if (decision.action !== "reject") {
        const source = decision.edits?.value ?? decision.edits?.amount ?? acct.cash_balance;
        // The parse output carries a confidence score on cash; the ledger's
        // money type does not. Strip it at the boundary rather than letting
        // an extraction artefact into the canonical record.
        const amount: Money = { amount: source.amount, currency: source.currency };
        ledger.holdings.push({
          account_id: account.id,
          instrument_id: cashInstrument(ledger, amount.currency, ids),
          asof: src.period.to,
          units: amount.amount,
          value: amount,
          source_document_id: docId,
        });
        entered = true;
      }
      log.push({ kind: "cash", account_token: acct.account_token, ref: `Cash (${acct.cash_balance.currency})`, action, ...(decision.note ? { note: decision.note } : {}) });
    }

    (acct.fees ?? []).forEach((fee, index) => {
      const decision = decide({ kind: "fee", accountToken: acct.account_token, index, ref: fee.label, fee });
      const action = outcome(decision);
      if (decision.action !== "reject") {
        const amount = decision.edits?.amount ?? decision.edits?.value ?? fee.amount;
        ledger.transactions.push({
          account_id: account!.id,
          date: decision.edits?.date ?? fee.period?.to ?? src.period.to,
          type: "fee",
          instrument_id: null,
          gross: amount,
          net: amount,
          source_document_id: docId,
        });
      }
      log.push({ kind: "fee", account_token: acct.account_token, ref: fee.label, action, ...(decision.note ? { note: decision.note } : {}) });
    });

    (acct.movements ?? []).forEach((move, index) => {
      const ref = `${move.date} ${move.type}`;
      const decision = decide({ kind: "movement", accountToken: acct.account_token, index, ref, movement: move });
      const action = outcome(decision);
      if (decision.action !== "reject") {
        const amount = decision.edits?.amount ?? decision.edits?.value ?? move.amount;
        ledger.transactions.push({
          account_id: account!.id,
          date: decision.edits?.date ?? move.date,
          type: move.type,
          instrument_id: null,
          gross: amount,
          net: amount,
          source_document_id: docId,
        });
      }
      log.push({ kind: "movement", account_token: acct.account_token, ref, action, ...(decision.note ? { note: decision.note } : {}) });
    });

    if (entered && src.period.to > account.data_asof) account.data_asof = src.period.to;
  });

  ledger.acceptances.push({
    id: ids(),
    document_id: docId,
    parse_run_id: run.id,
    accepted_at: options.acceptedAt,
    operator_initials: options.operatorInitials,
    lines: log,
  });
}

export function serializeLedger(ledger: Ledger): string {
  return JSON.stringify(ledger, null, 2) + "\n";
}
