// Return mathematics (SPEC §6.2). Pure and deterministic: no I/O, no system
// clock — every date is passed in. Where full transactions exist we compute
// true time-weighted return with daily linking and money-weighted XIRR; where
// only periodic snapshots and flows exist we fall back to Modified Dietz,
// which is ALWAYS labelled an estimate with its assumption stated.

export type ReturnMethod = "twr" | "modified_dietz";

export interface ReturnResult {
  return: number;
  method: ReturnMethod;
  isEstimate: boolean;
  assumption: string;
}

export interface Valuation {
  date: string;
  value: number;
}

export interface Flow {
  date: string;
  amount: number;
}

const MS_PER_DAY = 86_400_000;

/** Whole days between two ISO dates. Parsing a date string is not a clock read. */
export function daysBetween(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) throw new Error(`invalid date range ${from}..${to}`);
  return Math.round((b - a) / MS_PER_DAY);
}

/**
 * True time-weighted return: each sub-period return is computed on the value
 * before any flow at its end, then the sub-periods are geometrically linked.
 * Flows therefore have no effect on the result, which is the point — TWR
 * measures the manager, not the timing of the client's contributions.
 */
export function timeWeightedReturn(
  periods: { start: Valuation; end: Valuation; flowAtEnd?: number }[]
): ReturnResult {
  if (!periods.length) throw new Error("timeWeightedReturn: no periods supplied");
  let factor = 1;
  for (const p of periods) {
    if (p.start.value === 0) throw new Error(`timeWeightedReturn: zero opening value at ${p.start.date}`);
    factor *= p.end.value / p.start.value;
  }
  return {
    return: factor - 1,
    method: "twr",
    isEstimate: false,
    assumption: "sub-period returns measured on values before each flow, then geometrically linked",
  };
}

/**
 * Modified Dietz: weights each flow by the fraction of the period it was
 * present. An approximation to TWR, exact only when no flow occurs; §6.2
 * requires it to be labelled and its assumption stated.
 */
export function modifiedDietz(input: {
  start: Valuation;
  end: Valuation;
  flows: Flow[];
}): ReturnResult {
  const totalDays = daysBetween(input.start.date, input.end.date);
  if (totalDays <= 0) throw new Error("modifiedDietz: end date must follow start date");

  let netFlow = 0;
  let weightedFlow = 0;
  for (const flow of input.flows) {
    const elapsed = daysBetween(input.start.date, flow.date);
    if (elapsed < 0 || elapsed > totalDays) {
      throw new Error(`modifiedDietz: flow on ${flow.date} lies outside the period`);
    }
    const weight = (totalDays - elapsed) / totalDays;
    netFlow += flow.amount;
    weightedFlow += weight * flow.amount;
  }

  const denominator = input.start.value + weightedFlow;
  if (denominator === 0) throw new Error("modifiedDietz: zero weighted average capital");

  return {
    return: (input.end.value - input.start.value - netFlow) / denominator,
    method: "modified_dietz",
    isEstimate: true,
    assumption:
      "each flow weighted by the fraction of the period it was invested; assumes flows occur at the start of their day and that no unobserved flows happened between snapshots",
  };
}

/** Geometrically links sub-period returns; the chain is only as strong as its weakest method. */
export function chainLink(results: ReturnResult[]): ReturnResult {
  if (!results.length) throw new Error("chainLink: no results supplied");
  const factor = results.reduce((acc, r) => acc * (1 + r.return), 1);
  const estimated = results.filter((r) => r.isEstimate);
  return {
    return: factor - 1,
    method: estimated.length ? "modified_dietz" : "twr",
    isEstimate: estimated.length > 0,
    assumption: estimated.length
      ? `chain-linked; ${estimated.length} of ${results.length} sub-periods estimated (${estimated[0]!.assumption})`
      : "chain-linked true time-weighted sub-periods",
  };
}

/**
 * Money-weighted return (XIRR): the annualised rate that discounts the dated
 * cash flows to zero, on an actual/365 basis. Newton-Raphson with a bisection
 * fallback so the result does not depend on a lucky starting guess.
 */
export function xirr(flows: Flow[], tolerance = 1e-12, maxIterations = 200): number {
  if (flows.length < 2) throw new Error("xirr: at least two cash flows required");
  const hasPositive = flows.some((f) => f.amount > 0);
  const hasNegative = flows.some((f) => f.amount < 0);
  if (!hasPositive || !hasNegative) {
    throw new Error("xirr: cash flows must include both signs — no rate of return exists otherwise");
  }

  const base = flows.reduce((min, f) => (f.date < min ? f.date : min), flows[0]!.date);
  const years = flows.map((f) => daysBetween(base, f.date) / 365);

  const npv = (rate: number): number =>
    flows.reduce((sum, f, i) => sum + f.amount / Math.pow(1 + rate, years[i]!), 0);
  const dNpv = (rate: number): number =>
    flows.reduce((sum, f, i) => sum - (years[i]! * f.amount) / Math.pow(1 + rate, years[i]! + 1), 0);

  let rate = 0.1;
  for (let i = 0; i < maxIterations; i++) {
    const value = npv(rate);
    if (Math.abs(value) < tolerance) return rate;
    const slope = dNpv(rate);
    if (slope === 0 || !Number.isFinite(slope)) break;
    const next = rate - value / slope;
    if (!Number.isFinite(next) || next <= -1) break;
    if (Math.abs(next - rate) < tolerance) return next;
    rate = next;
  }

  // Bisection over a wide bracket: robust where Newton wanders.
  let low = -0.999999;
  let high = 100;
  let lowValue = npv(low);
  if (lowValue * npv(high) > 0) throw new Error("xirr: no sign change in the search bracket");
  for (let i = 0; i < 1000; i++) {
    const mid = (low + high) / 2;
    const value = npv(mid);
    if (Math.abs(value) < tolerance || high - low < tolerance) return mid;
    if (lowValue * value < 0) high = mid;
    else {
      low = mid;
      lowValue = value;
    }
  }
  throw new Error("xirr: failed to converge");
}

/** Deflates a nominal return by a price index over the same period (§6.2). */
export function realReturn(nominal: number, cpi: { start: number; end: number }): number {
  if (cpi.start <= 0) throw new Error("realReturn: invalid price index");
  return (1 + nominal) / (cpi.end / cpi.start) - 1;
}
