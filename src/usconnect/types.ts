// Public result shape for Module 3 (SPEC §7). Every explanation, severity,
// threshold and source string on these objects originates in /params — this
// module only joins, sums and orders them.
import type { Money } from "../ingest/types.ts";

export type { Money };

export type Severity = "OK" | "INFO" | "WARN" | "CRITICAL";
export type PficOutcome = "pfic" | "not_pfic" | "needs_classification";

export const SEVERITIES: readonly Severity[] = ["OK", "INFO", "WARN", "CRITICAL"];

export function isSeverity(v: unknown): v is Severity {
  return typeof v === "string" && (SEVERITIES as readonly string[]).includes(v);
}

/** §7.1: a PFIC inside a treaty-recognised pension is presented at a lower severity. */
export interface WrapperMitigation {
  wrapper: string;
  severityBefore: Severity;
  severity: Severity;
  explanation: string;
  sources: string[];
}

export interface PficHoldingDetail {
  instrumentId: string;
  instrumentName: string;
  instrumentType: string;
  domicile: string | null;
  accountToken: string;
  wrapper: string;
  wrapperJurisdiction: string;
  personTokens: string[];
  value: Money;
  valueBase: number;
  outcome: PficOutcome;
  severity: Severity;
  ruleId: string;
  explanation: string;
  filingImplication: string | null;
  sources: string[];
  wrapperMitigation: WrapperMitigation | null;
}

export interface PficDeMinimis {
  basis: string;
  thresholdCurrency: string;
  thresholdAmount: number;
  thresholdBase: number;
  aggregateValueBase: number;
  belowThreshold: boolean;
  source: string;
}

export interface PficSummary {
  /** Number of flagged *positions* (one instrument in two accounts counts twice). */
  positionCount: number;
  /** Number of distinct flagged instruments. */
  instrumentCount: number;
  totalValueBase: number;
  investableWealthBase: number;
  shareOfInvestableWealth: number;
  needsClassificationCount: number;
  needsClassificationValueBase: number;
  bySeverity: Record<Severity, number>;
}

export interface PficReporting {
  form: string;
  deMinimis: PficDeMinimis;
  position: string;
  sources: string[];
}

export interface PficSection {
  /** Every position held by or for a US person, with its cascade outcome. */
  holdings: PficHoldingDetail[];
  flagged: PficHoldingDetail[];
  needsClassification: PficHoldingDetail[];
  summary: PficSummary;
  reporting: PficReporting;
}

export interface WrapperCell {
  severity: Severity;
  explanation: string;
  sources: string[];
}

export interface WrapperConflict {
  wrapper: string;
  wrapperJurisdiction: string;
  accountTokens: string[];
  valueBase: number;
  /** US-person perspective — the module only runs when a US person exists. */
  severity: Severity;
  explanation: string;
  sources: string[];
  ukResident: WrapperCell;
}

export interface SitusItem {
  instrumentId: string;
  instrumentName: string;
  accountToken: string;
  wrapper: string;
  wrapperJurisdiction: string;
  valueBase: number;
  /** Share of the holding attributed to this person (joint accounts split equally). */
  attributedShare: number;
  assetClass: string | null;
  ruleId: string;
  explanation: string;
  sources: string[];
}

export interface SitusColumn {
  items: SitusItem[];
  totalBase: number;
}

export interface SitusPerson {
  personToken: string;
  usPerson: boolean;
  usSitus: SitusColumn;
  nonUsSitus: SitusColumn;
  /** Metadata-unconfirmed or unmatched holdings: never silently placed in a column. */
  unclassified: SitusColumn;
  usEstate: {
    basis: "worldwide" | "us_situs_only";
    exemptionUsd: number;
    nonresidentExemptionUsd: number;
    exemptionCurrency: string;
    note: string;
    sources: string[];
  };
  ukIht: {
    scope: "worldwide" | "uk_situs_only";
    note: string;
    sources: string[];
  };
}

export interface SitusSection {
  label: string;
  attribution: string;
  treatyCredit: { note: string; sources: string[] };
  persons: SitusPerson[];
}

export interface CurrencyRow {
  currency: string;
  portfolioShare: number;
  spendingShare: number | null;
  /** portfolioShare − spendingShare; null when no spending mix is set. */
  gap: number | null;
}

export interface CurrencyOfLifePerson {
  personToken: string;
  totalBase: number;
  portfolioMix: Record<string, number>;
  spendingMix: Record<string, number> | null;
  rows: CurrencyRow[];
  mismatchScore: number | null;
  band: string | null;
}

export interface CurrencyOfLifeSection {
  method: string;
  lookThrough: boolean;
  lookThroughNote: string;
  persons: CurrencyOfLifePerson[];
}

export interface Assumption {
  id: string;
  assumption: string;
  sources: string[];
}

export interface UsConnectResult {
  asof: string;
  baseCurrency: string;
  /** §8: the section opens with this number, not prose. */
  criticalCount: number;
  usPersons: { personToken: string; basis: string | null }[];
  pfic: PficSection;
  wrapperConflicts: WrapperConflict[];
  situs: SitusSection;
  currencyOfLife: CurrencyOfLifeSection;
  assumptions: Assumption[];
}
