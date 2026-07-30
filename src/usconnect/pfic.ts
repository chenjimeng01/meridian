// SPEC §7.1 — PFIC detector. The cascade itself lives in
// params/shared/pfic-rules.json; this file walks it, applies wrapper
// mitigation, and totals the exposure. No rule, severity or threshold here.
import { matchWhen, type CascadeRule, type SharedRules, type UsParams } from "./params.ts";
import { heldForAnyOf, subjectOf, type Position, type ToBase } from "./ledger-view.ts";
import { SEVERITIES, type PficHoldingDetail, type PficSection, type Severity } from "./types.ts";

function firstMatchingRule(rules: CascadeRule[], position: Position): CascadeRule {
  const subject = subjectOf(position);
  for (const rule of rules) {
    if (matchWhen(rule.when, subject, rule.id)) return rule;
  }
  throw new Error(
    `usconnect: the PFIC cascade in params matched nothing for ${position.instrumentName} — the cascade must be total`
  );
}

function assess(position: Position, rules: SharedRules): PficHoldingDetail {
  const rule = firstMatchingRule(rules.cascade, position);
  const mitigation =
    rule.outcome === "pfic"
      ? rules.mitigation.find((m) => m.wrappers.includes(position.wrapper))
      : undefined;

  const severity: Severity = mitigation ? mitigation.severity : rule.severity;
  return {
    instrumentId: position.instrumentId,
    instrumentName: position.instrumentName,
    instrumentType: position.instrumentType,
    domicile: position.domicile,
    accountToken: position.accountToken,
    wrapper: position.wrapper,
    wrapperJurisdiction: position.wrapperJurisdiction,
    personTokens: position.personTokens,
    value: position.value,
    valueBase: position.valueBase,
    outcome: rule.outcome,
    severity,
    ruleId: rule.id,
    explanation: rule.explanation,
    filingImplication: rule.filingImplication,
    sources: rule.sources,
    wrapperMitigation: mitigation
      ? {
          wrapper: position.wrapper,
          severityBefore: rule.severity,
          severity: mitigation.severity,
          explanation: mitigation.explanation,
          sources: mitigation.sources,
        }
      : null,
  };
}

export interface PficInput {
  positions: Position[];
  usPersonIds: Set<string>;
  rules: SharedRules;
  us: UsParams;
  toBase: ToBase;
  asof: string;
}

export function assessPfic(input: PficInput): PficSection {
  const { rules, us } = input;
  // A position enters the population if *any* owner is a US person, and it is
  // counted gross — not reduced to that person's share of a joint account. The
  // conservative reading for a flag: the whole holding is PFIC-exposed, and
  // `personTokens` on each row shows who owns it. (Situs, where the split
  // changes the exposure itself, does attribute by share.)
  const assessed = input.positions
    .filter((p) => heldForAnyOf(p, input.usPersonIds))
    .map((p) => assess(p, rules));

  const flagged = assessed.filter((h) => h.outcome === "pfic");
  const needsClassification = assessed.filter((h) => h.outcome === "needs_classification");

  const sum = (rows: PficHoldingDetail[]) => rows.reduce((acc, h) => acc + h.valueBase, 0);
  const totalValueBase = sum(flagged);
  const investableWealthBase = sum(
    assessed.filter((h) => !rules.investableWealthExcludedTypes.includes(h.instrumentType))
  );

  const bySeverity = Object.fromEntries(SEVERITIES.map((s) => [s, 0])) as Record<Severity, number>;
  for (const h of assessed) bySeverity[h.severity] += 1;

  // The de minimis threshold is a USD figure; convert it with the injected FX
  // rather than converting the portfolio out of base currency.
  const thresholdAmount = us.deMinimis[rules.reporting.filingStatusBasis];
  if (thresholdAmount === undefined) {
    throw new Error(
      `usconnect params: reporting.filing_status_assumption "${rules.reporting.filingStatusBasis}" is not a key of us pfic.de_minimis_reporting_exception`
    );
  }
  const unitBase = input.toBase({ amount: 1, currency: us.currency }, input.asof);
  if (!Number.isFinite(unitBase)) {
    throw new Error(
      `usconnect: injected FX returned a non-finite rate for ${us.currency} at ${input.asof}`
    );
  }
  const thresholdBase = thresholdAmount * unitBase;
  const belowThreshold = totalValueBase < thresholdBase;
  const position = belowThreshold ? rules.reporting.belowPosition : rules.reporting.abovePosition;

  return {
    holdings: assessed,
    flagged,
    needsClassification,
    summary: {
      positionCount: flagged.length,
      instrumentCount: new Set(flagged.map((h) => h.instrumentId)).size,
      totalValueBase,
      investableWealthBase,
      shareOfInvestableWealth:
        investableWealthBase === 0 ? 0 : totalValueBase / investableWealthBase,
      needsClassificationCount: needsClassification.length,
      needsClassificationValueBase: sum(needsClassification),
      bySeverity,
    },
    reporting: {
      form: us.pficForm,
      deMinimis: {
        basis: rules.reporting.filingStatusBasis,
        thresholdCurrency: us.currency,
        thresholdAmount,
        thresholdBase,
        aggregateValueBase: totalValueBase,
        belowThreshold,
        source: us.deMinimisSource,
      },
      position: position.text,
      sources: [position.source, rules.reporting.filingStatusSource],
    },
  };
}
