// Risk & exposure (SPEC §6.4). Pure functions over an already-consolidated
// result, so concentration and splits are always measured on the same
// converted figures the report shows.
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
  assetSplit: Slice[];
  geographicSplit: Slice[];
  currencyExposure: Slice[];
  wrappedRatioByJurisdiction: Record<string, { wrapped: number; unwrapped: number; wrappedShare: number }>;
  warnings: string[];
}

interface AssetClassDoc {
  wrapped_by_wrapper: Record<string, boolean | string>;
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

  const singleIssuerFlags: ConcentrationFlag[] = consolidation.byInstrument
    .filter((slice) => slice.shareOfTotal > threshold)
    .map((slice) => ({
      key: slice.key,
      label: slice.label,
      share: slice.shareOfTotal,
      amount: slice.value.base.amount,
    }));

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
      value: { base: { amount: Math.round(amount * 100) / 100, currency: consolidation.total.base.currency } },
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
    bucket.wrapped = Math.round(bucket.wrapped * 100) / 100;
    bucket.unwrapped = Math.round(bucket.unwrapped * 100) / 100;
    bucket.wrappedShare = sum === 0 ? 0 : bucket.wrapped / sum;
  }
  if (accountById.size === 0) warnings.push("no accounts in ledger");

  return {
    topPositions,
    singleIssuerFlags,
    assetSplit: consolidation.byAssetClass,
    geographicSplit,
    currencyExposure: consolidation.byCurrency,
    wrappedRatioByJurisdiction: jurisdictions,
    warnings,
  };
}
