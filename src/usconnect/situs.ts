// SPEC §7.3 — situs & estate exposure sketch. Two columns per person, plus a
// third for anything whose metadata is unconfirmed: an unverified instrument is
// never dropped into a column (PHASE_REVIEW_2 S7). Not advice.
import {
  matchWhen,
  type SharedRules,
  type SitusRule,
  type UkParams,
  type UsParams,
} from "./params.ts";
import { attributedShare, subjectOf, type Person, type Position } from "./ledger-view.ts";
import type { SitusColumn, SitusItem, SitusPerson, SitusSection } from "./types.ts";

function firstMatchingRule(rules: SitusRule[], position: Position): SitusRule {
  const subject = subjectOf(position);
  for (const rule of rules) {
    if (matchWhen(rule.when, subject, `situs.${rule.id}`)) return rule;
  }
  throw new Error(
    `usconnect: the situs cascade in params matched nothing for ${position.instrumentName} — the cascade must be total`
  );
}

function column(items: SitusItem[]): SitusColumn {
  return { items, totalBase: items.reduce((acc, i) => acc + i.valueBase, 0) };
}

function forPerson(
  person: Person,
  positions: Position[],
  rules: SharedRules,
  us: UsParams,
  uk: UkParams
): SitusPerson {
  const usSitus: SitusItem[] = [];
  const nonUsSitus: SitusItem[] = [];
  const unclassified: SitusItem[] = [];

  for (const position of positions) {
    const share = attributedShare(position, person.id);
    if (share === 0) continue;
    const rule = firstMatchingRule(rules.situs.rules, position);
    const assetClass = rule.assetClass === null ? null : rules.situs.assetClasses[rule.assetClass];
    if (rule.assetClass !== null && assetClass === undefined) {
      throw new Error(
        `usconnect params: situs rule ${rule.id} names undeclared asset class ${rule.assetClass}`
      );
    }
    const item: SitusItem = {
      instrumentId: position.instrumentId,
      instrumentName: position.instrumentName,
      accountToken: position.accountToken,
      wrapper: position.wrapper,
      wrapperJurisdiction: position.wrapperJurisdiction,
      valueBase: position.valueBase * share,
      attributedShare: share,
      assetClass: rule.assetClass,
      ruleId: rule.id,
      explanation: rule.explanation,
      sources: assetClass ? assetClass.sources : [],
    };
    if (assetClass === undefined || assetClass === null) unclassified.push(item);
    else if (assetClass.situs === "us") usSitus.push(item);
    else nonUsSitus.push(item);
  }

  const usWorldwide = person.usPerson;
  const ukWorldwide =
    person.ukDomicileStatus !== null &&
    rules.situs.longTermResidentFlags.includes(person.ukDomicileStatus);

  return {
    personToken: person.token,
    usPerson: person.usPerson,
    usSitus: column(usSitus),
    nonUsSitus: column(nonUsSitus),
    unclassified: column(unclassified),
    usEstate: {
      basis: usWorldwide ? "worldwide" : "us_situs_only",
      exemptionUsd: us.estateExemption,
      nonresidentExemptionUsd: us.nraExemption,
      exemptionCurrency: us.currency,
      note: usWorldwide ? rules.situs.usWorldwideNote.text : rules.situs.usSitusOnlyNote.text,
      sources: usWorldwide
        ? [rules.situs.usWorldwideNote.source, us.estateExemptionSource]
        : [rules.situs.usSitusOnlyNote.source, us.nraExemptionSource],
    },
    ukIht: {
      scope: ukWorldwide ? "worldwide" : "uk_situs_only",
      note: ukWorldwide ? rules.situs.ukWorldwideNote.text : rules.situs.ukSitusNote.text,
      sources: [
        ukWorldwide ? rules.situs.ukWorldwideNote.source : rules.situs.ukSitusNote.source,
        rules.situs.longTermResidentSource,
        uk.longTermResidenceSource,
      ],
    },
  };
}

export function buildSitus(
  persons: Person[],
  positions: Position[],
  rules: SharedRules,
  us: UsParams,
  uk: UkParams
): SitusSection {
  return {
    label: rules.situs.label,
    attribution: rules.situs.attribution,
    treatyCredit: {
      note: rules.situs.treatyCredit.note,
      sources: [rules.situs.treatyCredit.source],
    },
    persons: persons.map((p) => forPerson(p, positions, rules, us, uk)),
  };
}
