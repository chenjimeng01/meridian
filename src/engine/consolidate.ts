// Consolidation (SPEC §6.1): total wealth sliced every way the report needs,
// always renderable in base AND secondary currency. Pure: the ledger, the
// params and the valuation date are all passed in.
import { convert, roundHalfEven, type FxContext, type Money } from "./fx.ts";
import type { Ledger } from "../ingest/types.ts";

export interface DualMoney {
  base: Money;
  secondary?: Money;
}

export interface Slice {
  key: string;
  label: string;
  value: DualMoney;
  shareOfTotal: number;
}

export interface ConsolidationResult {
  asof: string;
  total: DualMoney;
  byPerson: Slice[];
  byAccount: Slice[];
  byWrapper: Slice[];
  byJurisdiction: Slice[];
  byAssetClass: Slice[];
  byCurrency: Slice[];
  byLiquidityTier: Slice[];
  byInstrument: Slice[];
  warnings: string[];
}

export interface ConsolidateInput {
  ledger: Ledger;
  assetClasses: unknown;
  fx: FxContext;
  asof: string;
  baseCurrency?: string;
  secondaryCurrency?: string;
}

interface AssetClassDoc {
  asset_class_by_type: Record<string, string>;
  liquidity_tier_by_type: Record<string, string>;
  wrapped_by_wrapper: Record<string, boolean | string>;
}

const LIQUIDITY_LABELS: Record<string, string> = {
  t0: "Same day",
  t1: "Next day",
  t2_5: "2-5 days",
  illiquid: "No reliable market",
};

/**
 * The holdings that still exist, as at `asof`.
 *
 * A statement is a complete picture of its account on its date, so a position
 * that appears on an older statement and NOT on the newest one has been sold.
 * Taking the latest snapshot per (account, instrument) instead — as this did —
 * resurrects every disposed position forever: sell a holding and it stays in
 * the client's total, in their concentration flags, and in their PFIC list.
 *
 * Each account is therefore read at its own most recent valuation date. That
 * date can differ between accounts (one platform reports quarterly, another
 * annually), which is exactly why the report shows freshness per account.
 */
export function latestHoldings(ledger: Ledger, asof: string): any[] {
  const latestDateByAccount = new Map<string, string>();
  for (const holding of ledger.holdings) {
    if (holding.asof > asof) continue;
    const current = latestDateByAccount.get(holding.account_id);
    if (!current || holding.asof > current) latestDateByAccount.set(holding.account_id, holding.asof);
  }
  return ledger.holdings.filter(
    (holding) => holding.asof === latestDateByAccount.get(holding.account_id)
  );
}

export function consolidate(input: ConsolidateInput): ConsolidationResult {
  const { ledger, asof } = input;
  const classes = input.assetClasses as AssetClassDoc;
  const base = input.baseCurrency ?? ledger.household.base_currency;
  const secondary = input.secondaryCurrency ?? ledger.household.secondary_currency;
  const warnings: string[] = [];

  const accountById = new Map(ledger.accounts.map((a: any) => [a.id, a]));
  const instrumentById = new Map(ledger.instruments.map((i: any) => [i.id, i]));
  const personById = new Map(ledger.household.persons.map((p) => [p.id, p]));

  const buckets = {
    person: new Map<string, { label: string; total: number }>(),
    account: new Map<string, { label: string; total: number }>(),
    wrapper: new Map<string, { label: string; total: number }>(),
    jurisdiction: new Map<string, { label: string; total: number }>(),
    assetClass: new Map<string, { label: string; total: number }>(),
    currency: new Map<string, { label: string; total: number }>(),
    liquidity: new Map<string, { label: string; total: number }>(),
    instrument: new Map<string, { label: string; total: number }>(),
  };

  const add = (bucket: Map<string, { label: string; total: number }>, key: string, label: string, value: number) => {
    const existing = bucket.get(key);
    if (existing) existing.total += value;
    else bucket.set(key, { label, total: value });
  };

  let total = 0;
  let lookThroughUsed = false;

  for (const holding of latestHoldings(ledger, asof)) {
    const account = accountById.get(holding.account_id);
    const instrument = instrumentById.get(holding.instrument_id);
    if (!account || !instrument) {
      throw new Error(`consolidate: holding references unknown account or instrument`);
    }
    const converted = convert(holding.value as Money, base, holding.asof, input.fx);
    warnings.push(...converted.warnings);
    // Full precision into the buckets; rounding happens once, at the boundary.
    const value = converted.exact;
    total += value;

    // Ownership: split evenly between joint owners. Recorded as an explicit
    // assumption rather than an arbitrary attribution to the first holder.
    const owners: string[] = account.person_ids;
    if (owners.length > 1) lookThroughUsed = true;
    for (const personId of owners) {
      const person = personById.get(personId);
      add(buckets.person, personId, person?.display_token ?? "unknown", value / owners.length);
    }

    add(buckets.account, account.account_token, `${account.account_token} · ${account.institution}`, value);
    add(buckets.wrapper, account.wrapper, account.wrapper, value);
    add(buckets.jurisdiction, account.wrapper_jurisdiction, account.wrapper_jurisdiction, value);

    const assetClass = classes.asset_class_by_type[instrument.type] ?? "other";
    add(buckets.assetClass, assetClass, assetClass, value);

    const tier = classes.liquidity_tier_by_type[instrument.type] ?? "illiquid";
    add(buckets.liquidity, tier, LIQUIDITY_LABELS[tier] ?? tier, value);

    // §6.1 asks for currency of *underlying* exposure. Without look-through
    // holdings data the quote currency is the best available proxy, and the
    // report must say so rather than imply precision it does not have.
    add(buckets.currency, holding.value.currency, holding.value.currency, value);

    add(buckets.instrument, instrument.id, instrument.name, value);
  }

  if (buckets.currency.size > 0) {
    warnings.push(
      "currency exposure is measured by each holding's quote currency; look-through to the underlying holdings of pooled funds is not available in v0"
    );
  }
  if (lookThroughUsed) {
    warnings.push("jointly held accounts are split evenly between their owners");
  }

  // Secondary figures are derived from the UNROUNDED base, then rounded once.
  // Rounding a rounded figure was how the two columns came to disagree with
  // their own headline by a penny (PHASE_REVIEW_3 M2).
  const secondaryExact = (exactBase: number, at: string): number | null => {
    if (!secondary || secondary === base) return null;
    try {
      return convert({ amount: exactBase, currency: base }, secondary, at, input.fx).exact;
    } catch {
      // A missing secondary rate must not sink the whole consolidation; the
      // base figure still stands and the omission is visible.
      warnings.push(`secondary-currency figure unavailable for ${at}`);
      return null;
    }
  };

  const round2 = (x: number) => roundHalfEven(x, 2);

  const totalSecondaryExact = secondaryExact(total, asof);
  const totalDual: DualMoney = {
    base: { amount: round2(total), currency: base },
    ...(totalSecondaryExact === null
      ? {}
      : { secondary: { amount: round2(totalSecondaryExact), currency: secondary! } }),
  };

  /**
   * Rounds each slice once and gives the rounding residual to the largest
   * slice, so a column always adds up to the headline above it. Without this
   * an instrument table in USD does not sum to the USD total (SPEC §8 calls
   * the dual-currency pair the signature of the product; a column that does
   * not add up is not renderable).
   */
  const toSlices = (bucket: Map<string, { label: string; total: number }>): Slice[] => {
    const entries = [...bucket.entries()]
      .map(([key, { label, total: exactBase }]) => ({
        key,
        label,
        exactBase,
        exactSecondary: secondaryExact(exactBase, asof),
        baseAmount: round2(exactBase),
        secondaryAmount: 0,
      }))
      .sort((a, b) => b.exactBase - a.exactBase || a.key.localeCompare(b.key));
    if (!entries.length) return [];

    const baseResidual = round2(totalDual.base.amount - entries.reduce((t, e) => round2(t + e.baseAmount), 0));
    entries[0]!.baseAmount = round2(entries[0]!.baseAmount + baseResidual);

    if (totalDual.secondary) {
      for (const entry of entries) entry.secondaryAmount = round2(entry.exactSecondary ?? 0);
      const secondaryResidual = round2(
        totalDual.secondary.amount - entries.reduce((t, e) => round2(t + e.secondaryAmount), 0)
      );
      entries[0]!.secondaryAmount = round2(entries[0]!.secondaryAmount + secondaryResidual);
    }

    return entries.map((entry) => ({
      key: entry.key,
      label: entry.label,
      value: {
        base: { amount: entry.baseAmount, currency: base },
        ...(totalDual.secondary
          ? { secondary: { amount: entry.secondaryAmount, currency: secondary! } }
          : {}),
      },
      shareOfTotal: total === 0 ? 0 : entry.exactBase / total,
    }));
  };

  return {
    asof,
    total: totalDual,
    byPerson: toSlices(buckets.person),
    byAccount: toSlices(buckets.account),
    byWrapper: toSlices(buckets.wrapper),
    byJurisdiction: toSlices(buckets.jurisdiction),
    byAssetClass: toSlices(buckets.assetClass),
    byCurrency: toSlices(buckets.currency),
    byLiquidityTier: toSlices(buckets.liquidity),
    byInstrument: toSlices(buckets.instrument),
    warnings: [...new Set(warnings)],
  };
}
