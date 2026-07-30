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
 * One observation point: the portfolio value on that date measured BEFORE any
 * flow settling the same day, plus that flow. Making "before the flow" part of
 * the type is deliberate — it is the single place TWR is usually got wrong.
 */
export interface Observation {
  date: string;
  /** Value before `flow` settles. */
  value: number;
  /** Net external flow settling on this date; positive is money in. */
  flow?: number;
}

/**
 * True time-weighted return: each sub-period return is measured on the value
 * before any flow at its end, and the next sub-period opens on that value plus
 * the flow. The flows therefore cancel out of the result, which is the point —
 * TWR measures the manager, not the timing of the client's contributions.
 *
 * The opening value of each sub-period is DERIVED from the previous
 * observation, never supplied separately: an API that let the caller state an
 * opening value inconsistent with the flow it just declared would silently
 * return a wrong number.
 */
export function timeWeightedReturn(observations: Observation[]): ReturnResult {
  if (observations.length < 2) {
    throw new Error("timeWeightedReturn: at least two observations required");
  }
  let factor = 1;
  for (let i = 1; i < observations.length; i++) {
    const previous = observations[i - 1]!;
    const current = observations[i]!;
    if (current.date <= previous.date) {
      throw new Error(`timeWeightedReturn: observations must be in date order (${previous.date} then ${current.date})`);
    }
    const opening = previous.value + (previous.flow ?? 0);
    if (opening === 0) {
      throw new Error(`timeWeightedReturn: zero opening value for the sub-period starting ${previous.date}`);
    }
    factor *= current.value / opening;
  }
  return {
    return: factor - 1,
    method: "twr",
    isEstimate: false,
    assumption:
      "each sub-period measured on the value before that date's flow, with the next sub-period opening on value plus flow, then geometrically linked",
  };
}

/**
 * True TWR over a valuation series and a dated flow series (SPEC §6.2's
 * "daily linking"): the series is broken at every observation date, so with
 * daily valuations the linking is daily.
 *
 * True TWR requires a valuation on every date a flow settles — without one the
 * flow cannot be separated from performance. Rather than quietly approximating,
 * this refuses and tells the caller to use Modified Dietz, which is labelled an
 * estimate.
 */
export function trueTimeWeightedReturn(input: {
  valuations: Valuation[];
  flows: Flow[];
}): ReturnResult {
  if (input.valuations.length < 2) {
    throw new Error("trueTimeWeightedReturn: at least two valuations required");
  }
  const valuations = [...input.valuations].sort((a, b) => a.date.localeCompare(b.date));
  const flowByDate = new Map<string, number>();
  for (const flow of input.flows) {
    flowByDate.set(flow.date, (flowByDate.get(flow.date) ?? 0) + flow.amount);
  }

  const first = valuations[0]!.date;
  const last = valuations[valuations.length - 1]!.date;
  const valuedDates = new Set(valuations.map((v) => v.date));
  for (const date of flowByDate.keys()) {
    if (date < first || date > last) {
      throw new Error(`trueTimeWeightedReturn: flow on ${date} lies outside the valuation series`);
    }
    if (!valuedDates.has(date)) {
      throw new Error(
        `trueTimeWeightedReturn: no valuation on ${date}, where a flow settles — true TWR needs one; use modifiedDietz and label the result an estimate`
      );
    }
  }

  const observations: Observation[] = valuations.map((v) => {
    const flow = flowByDate.get(v.date);
    return flow === undefined ? { date: v.date, value: v.value } : { date: v.date, value: v.value, flow };
  });
  // A flow on the final date is a withdrawal after the last measurement; it
  // cannot affect the return and must not be linked into it.
  const linked = timeWeightedReturn(observations);
  return {
    ...linked,
    assumption: `${linked.assumption}; linked across ${observations.length - 1} sub-periods between ${first} and ${last}`,
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
