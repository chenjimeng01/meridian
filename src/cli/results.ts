// Results assembly (SPEC §10 Phase 4 gate: "results JSON on fixture").
// Runs the whole deterministic engine over an accepted ledger and produces the
// single JSON object Phase 5's report renders. Every number here comes from
// Module 2 or Module 3 — nothing is computed inline, and no LLM is involved.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { consolidate, latestHoldings, type ConsolidationResult } from "../engine/consolidate.ts";
import { assessRisk, type RiskResult } from "../engine/risk.ts";
import { costStack, compoundingDrag, type CostStackResult, type CompoundingDragResult } from "../engine/cost.ts";
import { convert, type FxContext } from "../engine/fx.ts";
import { analyseUsConnect } from "../usconnect/index.ts";
import type { Ledger } from "../ingest/types.ts";

const DEFAULT_PARAMS_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../params");

/** Growth assumption for the §6.3 twenty-year drag projection. Operator-set. */
const DEFAULT_GROWTH_ASSUMPTION = 0.05;
const DRAG_YEARS = 20;

export interface Results {
  meta: {
    schema_version: "0.1";
    generated_at: string;
    asof: string;
    household_id: string;
    base_currency: string;
    secondary_currency?: string;
  };
  consolidation: ConsolidationResult;
  risk: RiskResult;
  costStack: CostStackResult;
  compoundingDrag: CompoundingDragResult;
  usConnect: unknown | null;
  appendix: {
    documents: {
      filename: string;
      institution: string;
      doc_type: string;
      sha256: string;
      period: { from: string; to: string };
      parsed_at?: string;
      accepted_at?: string;
    }[];
    instrumentsNeedingConfirmation: string[];
  };
  warnings: string[];
  disclaimer: string;
}

export const DISCLAIMER =
  "Analysis and information only. Not a personal recommendation. Not tax advice. US tax outcomes depend on elections and filings not visible to this system.";

export interface BuildResultsInput {
  ledger: Ledger;
  asof: string;
  generatedAt: string;
  paramsRoot?: string;
  growthAssumption?: number;
}

export function buildResults(input: BuildResultsInput): Results {
  const paramsRoot = input.paramsRoot ?? DEFAULT_PARAMS_ROOT;
  const readParams = (rel: string) => JSON.parse(readFileSync(join(paramsRoot, rel), "utf8"));

  const assetClasses = readParams("shared/asset-classes.json");
  const fxPolicy = readParams("shared/fx-policy.json");
  const { ledger, asof } = input;
  const fx: FxContext = { rates: ledger.fx_rates, policy: fxPolicy };
  const base = ledger.household.base_currency;

  const consolidation = consolidate({ ledger, assetClasses, fx, asof });
  const risk = assessRisk({ consolidation, ledger, assetClasses, asof });

  // §6.3 cost stack. Fee transactions are matched to the account they were
  // charged on; the base for bps is the mean of that account's snapshot totals,
  // which is stated as an assumption rather than implied to be exact.
  const costWarnings: string[] = [];
  const accountTotals = new Map<string, number[]>();
  for (const account of ledger.accounts) {
    const byDate = new Map<string, number>();
    const skipped = new Set<string>();
    for (const holding of ledger.holdings.filter((h) => h.account_id === account.id && h.asof <= asof)) {
      try {
        const value = convert(holding.value, base, holding.asof, fx).exact;
        byDate.set(holding.asof, (byDate.get(holding.asof) ?? 0) + value);
      } catch {
        // A historic snapshot with no usable FX rate must not sink the whole
        // report — it is dropped from the fee base and the omission is stated.
        // The headline consolidation uses only the latest snapshot, which is
        // valued or refused on its own merits.
        skipped.add(holding.asof);
        byDate.delete(holding.asof);
      }
    }
    for (const date of skipped) byDate.delete(date);
    accountTotals.set(account.id, [...byDate.values()]);
    if (skipped.size) {
      costWarnings.push(
        `cost base for ${account.account_token} excludes ${skipped.size} snapshot(s) (${[...skipped].sort().join(", ")}) that could not be valued in ${base} under the FX policy`
      );
    }
  }
  const documentById = new Map(ledger.documents.map((d) => [d.id, d]));
  const costAccounts = ledger.accounts
    .map((account) => {
      const totals = accountTotals.get(account.id) ?? [];
      const averageValue = totals.length ? totals.reduce((t, v) => t + v, 0) / totals.length : 0;
      const fees = ledger.transactions
        .filter((t) => t.account_id === account.id && t.type === "fee" && t.date <= asof)
        .map((t) => ({
          label: `Charges ${t.date}`,
          category: "platform",
          amount: t.gross ?? { amount: 0, currency: base },
          sourceDocument: documentById.get(t.source_document_id ?? "")?.filename ?? "manual entry",
        }));
      return { accountToken: account.account_token, averageValue: { amount: averageValue, currency: base }, fees };
    })
    .filter((entry) => entry.fees.length > 0);

  const stack = costStack({ accounts: costAccounts, baseCurrency: base });
  const growth = input.growthAssumption ?? DEFAULT_GROWTH_ASSUMPTION;
  const drag = compoundingDrag({
    startingValue: consolidation.total.base,
    grossGrowthRate: growth,
    annualFeeRate: stack.total.bps / 10_000,
    years: DRAG_YEARS,
  });

  const usConnect = analyseUsConnect({
    ledger,
    usParams: readParams("us/2026.json"),
    ukParams: readParams("uk/2026-27.json"),
    pficRules: readParams("shared/pfic-rules.json"),
    wrapperMatrix: readParams("shared/wrapper-matrix.json"),
    asof,
    toBase: (money, at) => convert(money, base, at, fx).exact,
  });

  const heldInstrumentIds = new Set(latestHoldings(ledger, asof).map((h) => h.instrument_id));
  const instrumentsNeedingConfirmation = ledger.instruments
    .filter((i) => heldInstrumentIds.has(i.id) && i.type !== "cash" && i.metadata_confirmed !== true)
    .map((i) => i.name)
    .sort();

  const warnings = [...consolidation.warnings, ...risk.warnings, ...costWarnings];
  if (instrumentsNeedingConfirmation.length) {
    warnings.push(
      `${instrumentsNeedingConfirmation.length} held instrument(s) have unconfirmed metadata, so they cannot be assessed for PFIC status and appear as "needs classification"`
    );
  }
  if (!costAccounts.length) {
    warnings.push("no cost disclosures have been ingested, so the cost stack is empty rather than zero");
  }

  return {
    meta: {
      schema_version: "0.1",
      generated_at: input.generatedAt,
      asof,
      household_id: ledger.household.id,
      base_currency: base,
      ...(ledger.household.secondary_currency ? { secondary_currency: ledger.household.secondary_currency } : {}),
    },
    consolidation,
    risk,
    costStack: stack,
    compoundingDrag: drag,
    usConnect,
    appendix: {
      // §8 section 6: every figure traceable to its document AND its parse date.
      documents: ledger.documents
        .map((d) => ({
          filename: d.filename,
          institution: d.institution,
          doc_type: d.doc_type,
          sha256: d.sha256,
          period: d.period,
          ...(d.parsed_at ? { parsed_at: d.parsed_at } : {}),
          ...(d.accepted_at ? { accepted_at: d.accepted_at } : {}),
        }))
        .sort((a, b) => a.filename.localeCompare(b.filename)),
      instrumentsNeedingConfirmation,
    },
    warnings: [...new Set(warnings)],
    disclaimer: DISCLAIMER,
  };
}
