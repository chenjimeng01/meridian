// FX conversion (SPEC §6.1 dual currency, params/shared/fx-policy.json).
// Pure and deterministic: rates and the valuation date are passed in, never
// looked up over the network and never derived from the system clock.
//
// The policy this implements, in one line: never use a rate the valuation date
// could not have seen, warn when the best available rate is stale, and refuse
// rather than quietly mislead when it is too stale.
import { daysBetween } from "./performance.ts";

export interface Money {
  amount: number;
  currency: string;
}

export interface FxRate {
  date: string;
  pair: string;
  rate: number;
  source: string;
}

export interface FxResult extends Money {
  rate: number;
  rateDate: string;
  /**
   * The unrounded converted amount. `amount` is rounded for presentation; the
   * policy is that the engine keeps full precision internally, so anything
   * that aggregates before displaying must use this (SPEC fx-policy rounding:
   * "banker's rounding on presentation only").
   */
  exact: number;
  /** Set when the rate was derived by triangulation rather than quoted directly. */
  via?: string;
  warnings: string[];
}

export class FxUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FxUnavailableError";
  }
}

interface FxPolicyDoc {
  policy: {
    nearest_rate_max_staleness_days: { value: number };
    refuse_conversion_beyond_days: { value: number };
    cross_rate_rule: { value: string };
    cross_rate_pivot: { value: string };
    date_mismatch_rule: { value: string };
    rounding: { value: { rate_decimal_places: number; amount_decimal_places: number; method: string } };
  };
}

export interface FxContext {
  rates: FxRate[];
  policy: unknown;
}

/** Banker's rounding — half-even, as the policy specifies for presentation. */
export function roundHalfEven(value: number, decimalPlaces: number): number {
  const factor = Math.pow(10, decimalPlaces);
  // Scale via string to avoid binary-float artefacts on exact .5 boundaries
  // (0.145 * 100 is 14.499999999999998 in IEEE754).
  const scaled = Number((value * factor).toPrecision(15));
  const floor = Math.floor(scaled);
  const diff = scaled - floor;
  let rounded: number;
  if (Math.abs(diff - 0.5) < Number.EPSILON) rounded = floor % 2 === 0 ? floor : floor + 1;
  else rounded = Math.round(scaled);
  const result = rounded / factor;
  return Object.is(result, -0) ? 0 : result;
}

/**
 * Most recent quote for base→quote on or before `asof`. Returns the direct
 * pair, or the inverse of the opposite pair; never a rate dated after `asof`.
 */
export function findRate(
  base: string,
  quote: string,
  asof: string,
  rates: FxRate[]
): { rate: number; date: string; inverted: boolean } | null {
  const direct = `${base}${quote}`;
  const opposite = `${quote}${base}`;
  let best: { rate: number; date: string; inverted: boolean } | null = null;
  for (const candidate of rates) {
    if (candidate.date > asof) continue; // policy: never a rate later than the valuation date
    if (candidate.pair !== direct && candidate.pair !== opposite) continue;
    if (best && candidate.date <= best.date) continue;
    best = {
      rate: candidate.pair === direct ? candidate.rate : 1 / candidate.rate,
      date: candidate.date,
      inverted: candidate.pair !== direct,
    };
  }
  return best;
}

const IMPLEMENTED_DATE_RULE = "use_rate_on_or_before_valuation_date";
const IMPLEMENTED_CROSS_RULE = "triangulate_via_pivot_when_direct_pair_absent";

/**
 * Reads the policy AND checks the code still implements what it says. A params
 * file the engine silently ignores is worse than no params file: it documents
 * a behaviour nobody has.
 */
function policyOf(raw: unknown): FxPolicyDoc["policy"] {
  const policy = (raw as FxPolicyDoc).policy;
  if (policy.date_mismatch_rule?.value !== IMPLEMENTED_DATE_RULE) {
    throw new Error(
      `fx: policy asks for date rule "${policy.date_mismatch_rule?.value}" but this engine implements "${IMPLEMENTED_DATE_RULE}"`
    );
  }
  if (policy.cross_rate_rule?.value !== IMPLEMENTED_CROSS_RULE) {
    throw new Error(
      `fx: policy asks for cross-rate rule "${policy.cross_rate_rule?.value}" but this engine implements "${IMPLEMENTED_CROSS_RULE}"`
    );
  }
  return policy;
}

function stalenessWarning(asof: string, rateDate: string, maxClean: number): string[] {
  const age = daysBetween(rateDate, asof);
  if (age <= maxClean) return [];
  return [
    `FX rate is ${age} days stale (dated ${rateDate} for a ${asof} valuation); figure shown but the rate predates the valuation by more than the ${maxClean}-day policy window`,
  ];
}

export function convert(money: Money, target: string, asof: string, ctx: FxContext): FxResult {
  const policy = policyOf(ctx.policy);
  const maxClean = policy.nearest_rate_max_staleness_days.value;
  const refuseBeyond = policy.refuse_conversion_beyond_days.value;
  const dp = policy.rounding.value.amount_decimal_places;

  if (money.currency === target) {
    return { amount: money.amount, currency: target, exact: money.amount, rate: 1, rateDate: asof, warnings: [] };
  }

  const direct = findRate(money.currency, target, asof, ctx.rates);
  if (direct) {
    const age = daysBetween(direct.date, asof);
    if (age > refuseBeyond) {
      throw new FxUnavailableError(
        `refusing ${money.currency}->${target} conversion for ${asof}: nearest rate is ${age} days old (dated ${direct.date}), beyond the ${refuseBeyond}-day policy limit — enter the rate manually`
      );
    }
    return {
      amount: roundHalfEven(money.amount * direct.rate, dp),
      currency: target,
      exact: money.amount * direct.rate,
      rate: direct.rate,
      rateDate: direct.date,
      warnings: stalenessWarning(asof, direct.date, maxClean),
    };
  }

  // No direct pair: triangulate through the policy's pivot currency.
  const pivot = policy.cross_rate_pivot.value;
  if (money.currency !== pivot && target !== pivot) {
    const legA = findRate(money.currency, pivot, asof, ctx.rates);
    const legB = findRate(target, pivot, asof, ctx.rates);
    if (legA && legB) {
      const oldest = legA.date < legB.date ? legA.date : legB.date;
      const age = daysBetween(oldest, asof);
      if (age > refuseBeyond) {
        throw new FxUnavailableError(
          `refusing ${money.currency}->${target} conversion for ${asof}: triangulated rate relies on a quote ${age} days old (dated ${oldest}), beyond the ${refuseBeyond}-day policy limit`
        );
      }
      const rate = legA.rate / legB.rate;
      return {
        amount: roundHalfEven(money.amount * rate, dp),
        currency: target,
        exact: money.amount * rate,
        rate,
        rateDate: oldest,
        via: pivot,
        warnings: stalenessWarning(asof, oldest, maxClean),
      };
    }
  }

  throw new FxUnavailableError(
    `no ${money.currency}->${target} rate available on or before ${asof} (directly or via ${pivot}) — enter the rate manually`
  );
}

/** Convenience for consolidation: convert and return the bare number. */
export function toCurrency(money: Money, target: string, asof: string, ctx: FxContext): number {
  return convert(money, target, asof, ctx).amount;
}
