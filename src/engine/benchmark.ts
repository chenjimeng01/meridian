// Benchmarks and real returns (SPEC §6.2). Composites are built from the
// bundled monthly index series in params/shared/benchmarks/ and are always
// reported alongside the method label of the portfolio return they sit next to,
// so a Modified Dietz estimate is never silently compared against an exact
// index return.
//
// Pure: series, weights and dates are all passed in.
import { daysBetween, realReturn, type ReturnResult } from "./performance.ts";

export interface IndexSeries {
  name: string;
  display_name?: string;
  kind?: string;
  currency: string;
  frequency: string;
  series: { date: string; value: number }[];
  source?: string;
}

export interface CompositeComponent {
  series: IndexSeries;
  /** Fraction of the composite, e.g. 0.6. Weights must sum to 1. */
  weight: number;
}

export interface BenchmarkResult {
  return: number;
  components: { name: string; weight: number; return: number }[];
  from: string;
  to: string;
  currency: string;
  assumption: string;
  warnings: string[];
}

const WEIGHT_TOLERANCE = 1e-9;
/** Monthly series: a month-end observation may sit a few days before the date asked for. */
const MAX_SERIES_STALENESS_DAYS = 35;

/** Index level on or before `date` — never a later observation, mirroring the FX rule. */
export function levelAt(series: IndexSeries, date: string): { value: number; date: string } | null {
  let best: { value: number; date: string } | null = null;
  for (const point of series.series) {
    if (point.date > date) continue;
    if (!best || point.date > best.date) best = { value: point.value, date: point.date };
  }
  return best;
}

export function seriesReturn(series: IndexSeries, from: string, to: string): { return: number; warnings: string[] } {
  if (to <= from) throw new Error(`seriesReturn: ${to} does not follow ${from}`);
  const start = levelAt(series, from);
  const end = levelAt(series, to);
  if (!start || !end) {
    throw new Error(`seriesReturn: ${series.name} has no observation on or before ${!start ? from : to}`);
  }
  if (start.value <= 0) throw new Error(`seriesReturn: ${series.name} has a non-positive level at ${start.date}`);

  const warnings: string[] = [];
  for (const [label, point, asked] of [
    ["start", start, from],
    ["end", end, to],
  ] as const) {
    const age = daysBetween(point.date, asked);
    if (age > MAX_SERIES_STALENESS_DAYS) {
      warnings.push(
        `${series.name} ${label} observation is ${age} days before ${asked} (dated ${point.date}); the comparison period does not line up with the index`
      );
    }
  }
  return { return: end.value / start.value - 1, warnings };
}

/**
 * A weighted composite (e.g. 60/40 in GBP terms). Modelled as continuously
 * rebalanced to the target weights — the standard convention for a stated
 * benchmark, and the assumption is returned so the report can say so.
 */
export function compositeReturn(components: CompositeComponent[], from: string, to: string): BenchmarkResult {
  if (!components.length) throw new Error("compositeReturn: no components supplied");
  const weightSum = components.reduce((t, c) => t + c.weight, 0);
  if (Math.abs(weightSum - 1) > WEIGHT_TOLERANCE) {
    throw new Error(`compositeReturn: weights sum to ${weightSum}, expected 1`);
  }
  const currencies = new Set(components.map((c) => c.series.currency));
  if (currencies.size > 1) {
    throw new Error(
      `compositeReturn: components span ${[...currencies].join(", ")} — convert the series to one currency before compositing`
    );
  }

  const warnings: string[] = [];
  const detail = components.map((component) => {
    const result = seriesReturn(component.series, from, to);
    warnings.push(...result.warnings);
    return { name: component.series.name, weight: component.weight, return: result.return };
  });

  return {
    return: detail.reduce((total, c) => total + c.weight * c.return, 0),
    components: detail,
    from,
    to,
    currency: [...currencies][0]!,
    assumption: `${detail.map((c) => `${Math.round(c.weight * 100)}% ${c.name}`).join(" / ")}, rebalanced continuously to those weights, measured in ${[...currencies][0]}`,
    warnings: [...new Set(warnings)],
  };
}

export interface BenchmarkComparison {
  portfolio: { nominal: number; real: number; method: string; isEstimate: boolean };
  benchmark: { nominal: number; real: number; assumption: string };
  excessNominal: number;
  inflation: number;
  from: string;
  to: string;
  warnings: string[];
}

/**
 * Portfolio against its assigned composite, nominal and real (SPEC §6.2
 * "Report both nominal and real"). The portfolio's return method travels with
 * the comparison so an estimate is never presented as if it were exact.
 */
export function compareToBenchmark(input: {
  portfolio: ReturnResult;
  benchmark: BenchmarkResult;
  cpi: IndexSeries;
  from: string;
  to: string;
}): BenchmarkComparison {
  const cpi = seriesReturn(input.cpi, input.from, input.to);
  const start = levelAt(input.cpi, input.from)!;
  const end = levelAt(input.cpi, input.to)!;
  const deflate = (nominal: number) => realReturn(nominal, { start: start.value, end: end.value });

  const warnings = [...input.benchmark.warnings, ...cpi.warnings];
  if (input.portfolio.isEstimate) {
    warnings.push(
      `portfolio return is a ${input.portfolio.method} estimate; the benchmark return is exact, so the difference between them carries that estimate's error`
    );
  }

  return {
    portfolio: {
      nominal: input.portfolio.return,
      real: deflate(input.portfolio.return),
      method: input.portfolio.method,
      isEstimate: input.portfolio.isEstimate,
    },
    benchmark: {
      nominal: input.benchmark.return,
      real: deflate(input.benchmark.return),
      assumption: input.benchmark.assumption,
    },
    excessNominal: input.portfolio.return - input.benchmark.return,
    inflation: cpi.return,
    from: input.from,
    to: input.to,
    warnings: [...new Set(warnings)],
  };
}
