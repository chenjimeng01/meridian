// Risk & exposure (SPEC §6.4). Pure functions over an already-consolidated
// result, so concentration and splits are always measured on the same
// converted figures the report shows.
import { roundHalfEven } from "./fx.ts";
import type { ConsolidationResult, Slice } from "./consolidate.ts";

export interface ConcentrationFlag {
  key: string;
  label: string;
  share: number;
  amount: number;
}

export interface RiskResult {
  topPositions: Slice[];
  singleIssuerFlags: ConcentrationFlag[];
  /** The base concentration is measured against (§6.4), and what it excludes. */
  investableWealth: { amount: number; currency: string; excludedTypes: string[] };
  assetSplit: Slice[];
  geographicSplit: Slice[];
  currencyExposure: Slice[];
  wrappedRatioByJurisdiction: Record<string, { wrapped: number; unwrapped: number; wrappedShare: number }>;
  warnings: string[];
}

interface AssetClassDoc {
  wrapped_by_wrapper: Record<string, boolean | string>;
  asset_class_by_type: Record<string, string>;
  investable_wealth: { excluded_types: { value: string[] } };
  concentration: {
    single_issuer_flag_threshold: { value: number };
    top_positions_count: { value: number };
  };
}

export interface RiskInput {
  consolidation: ConsolidationResult;
  ledger: { accounts: any[]; instruments: any[]; holdings: any[] };
  assetClasses: unknown;
  asof: string;
}

export function assessRisk(input: RiskInput): RiskResult {
  const params = input.assetClasses as AssetClassDoc;
  const threshold = params.concentration.single_issuer_flag_threshold.value;
  const topCount = params.concentration.top_positions_count.value;
  const { consolidation } = input;
  const warnings: string[] = [];

  const topPositions = consolidation.byInstrument.slice(0, topCount);

  // §6.4 concentration is about invested capital. Measuring a position against
  // TOTAL wealth understates it by however much cash the client happens to be
  // holding — a 6% position looks like 4% simply because a deposit account sits
  // beside it.
  const instrumentTypes = new Map(input.ledger.instruments.map((i: any) => [i.id, i.type]));
  const excludedTypes = params.investable_wealth.excluded_types.value;
  const investable = consolidation.byInstrument
    .filter((slice) => !excludedTypes.includes(String(instrumentTypes.get(slice.key))))
    .reduce((sum, slice) => sum + slice.value.base.amount, 0);

  const singleIssuerFlags: ConcentrationFlag[] = consolidation.byInstrument
    .filter((slice) => !excludedTypes.includes(String(instrumentTypes.get(slice.key))))
    .map((slice) => ({
      key: slice.key,
      label: slice.label,
      share: investable === 0 ? 0 : slice.value.base.amount / investable,
      amount: slice.value.base.amount,
    }))
    .filter((flag) => flag.share > threshold);

  // Geographic split by instrument domicile. Cash and anything without a
  // confirmed domicile is reported as unallocated rather than guessed.
  const instrumentById = new Map(input.ledger.instruments.map((i: any) => [i.id, i]));
  const geographic = new Map<string, number>();
  for (const slice of consolidation.byInstrument) {
    const instrument = instrumentById.get(slice.key);
    const domicile: string = instrument?.domicile ?? "unallocated";
    geographic.set(domicile, (geographic.get(domicile) ?? 0) + slice.value.base.amount);
  }
  const total = consolidation.total.base.amount;
  const geographicSplit: Slice[] = [...geographic.entries()]
    .map(([key, amount]) => ({
      key,
      label: key === "unallocated" ? "Unallocated (cash and unconfirmed domicile)" : key,
      value: { base: { amount: roundHalfEven(amount, 2), currency: consolidation.total.base.currency } },
      shareOfTotal: total === 0 ? 0 : amount / total,
    }))
    .sort((a, b) => b.value.base.amount - a.value.base.amount || a.key.localeCompare(b.key));
  if (geographic.has("unallocated")) {
    warnings.push("geographic split excludes cash and instruments whose domicile is not confirmed");
  }

  // Wrapped vs unwrapped, per jurisdiction (§6.4).
  const accountById = new Map(input.ledger.accounts.map((a: any) => [a.id, a]));
  const jurisdictions: Record<string, { wrapped: number; unwrapped: number; wrappedShare: number }> = {};
  for (const slice of consolidation.byAccount) {
    const account = input.ledger.accounts.find((a: any) => a.account_token === slice.key);
    if (!account) continue;
    const bucket = (jurisdictions[account.wrapper_jurisdiction] ??= { wrapped: 0, unwrapped: 0, wrappedShare: 0 });
    const isWrapped = params.wrapped_by_wrapper[account.wrapper] === true;
    if (isWrapped) bucket.wrapped += slice.value.base.amount;
    else bucket.unwrapped += slice.value.base.amount;
  }
  for (const bucket of Object.values(jurisdictions)) {
    const sum = bucket.wrapped + bucket.unwrapped;
    bucket.wrapped = roundHalfEven(bucket.wrapped, 2);
    bucket.unwrapped = roundHalfEven(bucket.unwrapped, 2);
    bucket.wrappedShare = sum === 0 ? 0 : bucket.wrapped / sum;
  }
  if (accountById.size === 0) warnings.push("no accounts in ledger");

  return {
    topPositions,
    singleIssuerFlags,
    investableWealth: {
      amount: roundHalfEven(investable, 2),
      currency: consolidation.total.base.currency,
      excludedTypes,
    },
    assetSplit: consolidation.byAssetClass,
    geographicSplit,
    currencyExposure: consolidation.byCurrency,
    wrappedRatioByJurisdiction: jurisdictions,
    warnings,
  };
}
