// Module 3 — US-connected intelligence (SPEC §7).
//
// Runs only when a household person is a US person; returns null otherwise, so
// the report can omit the section entirely rather than render empty shells
// (§7 acceptance: "module silently absent, not empty sections").
//
// Pure and deterministic: no clock, no randomness, no I/O, no env. `asof` and
// the FX converter are injected; every rate, threshold, severity and
// explanation string comes from /params.
import type { Ledger } from "../ingest/types.ts";
import {
  assertSitusClassIntegrity,
  readSharedRules,
  readUkParams,
  readUsParams,
  readWrapperMatrix,
} from "./params.ts";
import { buildPositions, readPersons, readWrappers, type ToBase } from "./ledger-view.ts";
import { assessPfic } from "./pfic.ts";
import { buildWrapperConflicts } from "./wrapper.ts";
import { buildSitus } from "./situs.ts";
import { buildCurrencyOfLife } from "./currency.ts";
import type { Assumption, Money, UsConnectResult } from "./types.ts";

export * from "./types.ts";
export type { Position } from "./ledger-view.ts";

export interface UsConnectInput {
  ledger: Ledger;
  /** Parsed params/us/2026.json */
  usParams: unknown;
  /** Parsed params/uk/2026-27.json */
  ukParams: unknown;
  /** Parsed params/shared/pfic-rules.json */
  pficRules: unknown;
  /** SPEC §7.3 situs cascade (params/shared/situs-rules.json). */
  situsRules?: unknown;
  /** SPEC §7.4 configuration (params/shared/currency-of-life.json). */
  currencyOfLifeRules?: unknown;
  /** Parsed params/shared/wrapper-matrix.json */
  wrapperMatrix: unknown;
  /** ISO date the analysis is stated as at. Never read from the clock. */
  asof: string;
  /** Injected FX: converts any Money into household base currency at `asof`. */
  toBase: ToBase;
  /** Operator-set spending currency mix per person token, e.g. { P1: { GBP: 0.8, USD: 0.2 } }. */
  currencyOfLife?: Record<string, Record<string, number>>;
}

export function analyseUsConnect(input: UsConnectInput): UsConnectResult | null {
  const persons = readPersons(input.ledger);
  const usPersons = persons.filter((p) => p.usPerson);
  if (usPersons.length === 0) return null;

  // The §7 rules live in three properly-named params files; the reader takes
  // one document, so they are composed here rather than in every caller.
  const rules = readSharedRules({
    ...(input.pficRules as Record<string, unknown>),
    ...((input.situsRules as Record<string, unknown>) ?? {}),
    ...((input.currencyOfLifeRules as Record<string, unknown>) ?? {}),
  });
  const us = readUsParams(input.usParams);
  const uk = readUkParams(input.ukParams);
  const matrix = readWrapperMatrix(input.wrapperMatrix);
  assertSitusClassIntegrity(rules.situs.assetClasses, us);

  const toBase: ToBase = (money: Money, asof: string) => input.toBase(money, asof);
  const positions = buildPositions(input.ledger, toBase, input.asof);
  const usPersonIds = new Set(usPersons.map((p) => p.id));

  const pfic = assessPfic({ positions, usPersonIds, rules, us, toBase, asof: input.asof });
  const wrapperConflicts = buildWrapperConflicts(readWrappers(input.ledger), positions, matrix);
  const situs = buildSitus(persons, positions, rules, us, uk);
  const currencyOfLife = buildCurrencyOfLife(persons, positions, rules, input.currencyOfLife);

  const criticalCount =
    pfic.holdings.filter((h) => h.severity === "CRITICAL").length +
    wrapperConflicts.filter((w) => w.severity === "CRITICAL").length;

  const assumptions: Assumption[] = [
    {
      id: "situs_treaty_credit",
      assumption: situs.treatyCredit.note,
      sources: situs.treatyCredit.sources,
    },
    {
      id: "situs_attribution",
      assumption: rules.situs.attributionNote,
      sources: ["params/shared/pfic-rules.json situs.attribution"],
    },
    {
      id: "pfic_filing_status",
      assumption: pfic.reporting.position,
      sources: pfic.reporting.sources,
    },
    {
      id: "currency_look_through",
      assumption: currencyOfLife.lookThroughNote,
      sources: ["params/shared/pfic-rules.json currency_of_life.look_through"],
    },
    {
      id: "uk_iht_scope",
      assumption: rules.situs.longTermResidentSource,
      sources: [uk.longTermResidenceSource],
    },
  ];
  for (const rule of rules.mitigation) {
    if (
      pfic.holdings.some((h) => h.wrapperMitigation !== null && rule.wrappers.includes(h.wrapper))
    ) {
      assumptions.push({
        id: "pfic_wrapper_mitigation",
        assumption: rule.explanation,
        sources: rule.sources,
      });
      break;
    }
  }

  return {
    asof: input.asof,
    baseCurrency: input.ledger.household.base_currency,
    criticalCount,
    usPersons: usPersons.map((p) => ({ personToken: p.token, basis: p.usPersonBasis })),
    pfic,
    wrapperConflicts,
    situs,
    currencyOfLife,
    assumptions,
  };
}
