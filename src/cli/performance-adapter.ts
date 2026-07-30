// Ledger → performance adapter (SPEC §6.2, closing PHASE_REVIEW_3 S7 and
// PHASE_REVIEW_4 M6). Turns accepted snapshots and flows into the Valuation[]
// and Flow[] the engine needs, then reports the return with its method label.
//
// v0 ledgers hold periodic snapshots rather than daily valuations, and flows
// rarely land on a valuation date, so the honest method is Modified Dietz —
// always labelled an estimate. True TWR is used when the data supports it.
import { convert, type FxContext } from "../engine/fx.ts";
import { modifiedDietz, trueTimeWeightedReturn, type Flow, type ReturnResult, type Valuation } from "../engine/performance.ts";
import { compareToBenchmark, compositeReturn, type BenchmarkComparison, type IndexSeries } from "../engine/benchmark.ts";
import type { Ledger } from "../ingest/types.ts";

/** Flow types that are external money in or out, as opposed to internal trades. */
const EXTERNAL_INFLOWS = new Set(["contribution", "transfer_in"]);
const EXTERNAL_OUTFLOWS = new Set(["withdrawal", "transfer_out"]);

export interface PerformanceSection {
  from: string;
  to: string;
  portfolio: ReturnResult | null;
  benchmark: BenchmarkComparison | null;
  perAccount: { accountToken: string; from: string; to: string; return: ReturnResult }[];
  warnings: string[];
}

export interface BenchmarkAssignment {
  /** Component series name → weight; weights must sum to 1. */
  weights: Record<string, number>;
}

/**
 * Portfolio-level valuations, carried forward per account.
 *
 * Summing whatever snapshots happen to share a date is badly wrong: an account
 * first ingested half way through the period would appear as portfolio growth.
 * On the fixture household that produced a reported +180% return that was
 * purely accounts arriving. So: each account's latest value at or before each
 * observation date is carried forward, and the series starts only once EVERY
 * account is represented. The truncation is reported, not silently applied.
 */
function portfolioSeries(
  ledger: Ledger,
  base: string,
  fx: FxContext,
  asof: string
): { valuations: Valuation[]; skipped: string[]; truncatedFrom: string | null } {
  const perAccount = new Map<string, { date: string; value: number }[]>();
  const skipped = new Set<string>();

  for (const account of ledger.accounts) {
    const series = valuationSeries(ledger, account.id, base, fx, asof);
    for (const date of series.skipped) skipped.add(date);
    if (series.valuations.length) perAccount.set(account.id, series.valuations);
  }
  if (!perAccount.size) return { valuations: [], skipped: [...skipped].sort(), truncatedFrom: null };

  // The earliest date at which every account with data is represented.
  const firstDates = [...perAccount.values()].map((series) => series[0]!.date).sort();
  const commonStart = firstDates[firstDates.length - 1]!;
  const earliest = firstDates[0]!;

  const observationDates = [
    ...new Set([...perAccount.values()].flatMap((series) => series.map((point) => point.date))),
  ]
    .filter((date) => date >= commonStart)
    .sort();

  const valuations = observationDates.map((date) => {
    let total = 0;
    for (const series of perAccount.values()) {
      const latest = series.filter((point) => point.date <= date).at(-1);
      if (latest) total += latest.value;
    }
    return { date, value: total };
  });

  return {
    valuations,
    skipped: [...skipped].sort(),
    truncatedFrom: commonStart > earliest ? commonStart : null,
  };
}

function valuationSeries(
  ledger: Ledger,
  accountId: string | null,
  base: string,
  fx: FxContext,
  asof: string
): { valuations: Valuation[]; skipped: string[] } {
  const byDate = new Map<string, number>();
  const skipped = new Set<string>();
  const rows = ledger.holdings.filter((h) => h.asof <= asof && (accountId === null || h.account_id === accountId));
  // A snapshot date only counts if EVERY position in it can be valued —
  // a partial total would look like a loss.
  const datesWithFailure = new Set<string>();
  for (const holding of rows) {
    try {
      byDate.set(holding.asof, (byDate.get(holding.asof) ?? 0) + convert(holding.value, base, holding.asof, fx).exact);
    } catch {
      datesWithFailure.add(holding.asof);
      skipped.add(holding.asof);
    }
  }
  for (const date of datesWithFailure) byDate.delete(date);
  const valuations = [...byDate.entries()]
    .map(([date, value]) => ({ date, value }))
    .sort((a, b) => a.date.localeCompare(b.date));
  return { valuations, skipped: [...skipped].sort() };
}

function flowSeries(ledger: Ledger, accountId: string | null, base: string, fx: FxContext, from: string, to: string): Flow[] {
  return ledger.transactions
    .filter((t) => (accountId === null || t.account_id === accountId) && t.date > from && t.date <= to)
    .filter((t) => EXTERNAL_INFLOWS.has(t.type) || EXTERNAL_OUTFLOWS.has(t.type))
    .map((t) => {
      const money = t.net ?? t.gross;
      if (!money) return null;
      const amount = convert(money, base, t.date, fx).exact;
      return { date: t.date, amount: EXTERNAL_OUTFLOWS.has(t.type) ? -Math.abs(amount) : Math.abs(amount) };
    })
    .filter((f): f is Flow => f !== null)
    .sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * True TWR where every flow date is also a valuation date; Modified Dietz
 * otherwise. Never silently approximates — the returned method says which.
 */
function measure(valuations: Valuation[], flows: Flow[]): ReturnResult | null {
  if (valuations.length < 2) return null;
  const first = valuations[0]!;
  const last = valuations[valuations.length - 1]!;
  if (first.value <= 0) return null;
  try {
    return trueTimeWeightedReturn({ valuations, flows });
  } catch {
    return modifiedDietz({ start: first, end: last, flows });
  }
}

export function buildPerformance(input: {
  ledger: Ledger;
  base: string;
  fx: FxContext;
  asof: string;
  cpi?: IndexSeries;
  benchmark?: BenchmarkAssignment;
  seriesByName?: Record<string, IndexSeries>;
}): PerformanceSection {
  const { ledger, base, fx, asof } = input;
  const warnings: string[] = [];

  const total = portfolioSeries(ledger, base, fx, asof);
  if (total.truncatedFrom) {
    warnings.push(
      `portfolio performance starts at ${total.truncatedFrom}, the first date on which every account has a valuation — measuring from earlier would report accounts arriving as growth`
    );
  }
  if (total.skipped.length) {
    warnings.push(
      `performance excludes ${total.skipped.length} snapshot date(s) (${total.skipped.join(", ")}) where at least one position could not be valued in ${base}`
    );
  }
  const from = total.valuations[0]?.date ?? asof;
  const to = total.valuations[total.valuations.length - 1]?.date ?? asof;
  const portfolio = measure(total.valuations, flowSeries(ledger, null, base, fx, from, to));
  if (!portfolio) {
    warnings.push("performance needs at least two valuation dates; only one accepted snapshot date is available");
  }

  const perAccount = ledger.accounts
    .map((account) => {
      const series = valuationSeries(ledger, account.id, base, fx, asof);
      if (series.valuations.length < 2) return null;
      const accountFrom = series.valuations[0]!.date;
      const accountTo = series.valuations[series.valuations.length - 1]!.date;
      const result = measure(series.valuations, flowSeries(ledger, account.id, base, fx, accountFrom, accountTo));
      return result ? { accountToken: account.account_token, from: accountFrom, to: accountTo, return: result } : null;
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null);

  let benchmark: BenchmarkComparison | null = null;
  if (portfolio && input.benchmark && input.seriesByName && input.cpi) {
    try {
      const components = Object.entries(input.benchmark.weights).map(([name, weight]) => {
        const series = input.seriesByName![name];
        if (!series) throw new Error(`benchmark series "${name}" is not bundled in params/shared/benchmarks/`);
        return { series, weight };
      });
      benchmark = compareToBenchmark({
        portfolio,
        benchmark: compositeReturn(components, from, to),
        cpi: input.cpi,
        from,
        to,
      });
    } catch (error) {
      warnings.push(`benchmark comparison unavailable: ${(error as Error).message}`);
    }
  } else if (portfolio && !input.benchmark) {
    warnings.push(
      "no benchmark is assigned for this household, so performance is reported without a comparison (SPEC §6.2 expects a user-assigned composite)"
    );
  }

  return { from, to, portfolio, benchmark, perAccount, warnings };
}
