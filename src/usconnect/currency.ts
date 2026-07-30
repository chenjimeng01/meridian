// SPEC §7.4 — currency of life. Portfolio currency exposure vs the operator-set
// spending mix, scored by total variation distance (defined in params, quoted
// on the result so the report can state the method).
import type { SharedRules } from "./params.ts";
import { attributedShare, type Person, type Position } from "./ledger-view.ts";
import type { CurrencyOfLifePerson, CurrencyOfLifeSection, CurrencyRow } from "./types.ts";

/** Normalise an operator mix to shares summing to 1; rejects a degenerate mix. */
function normalise(mix: Record<string, number>, personToken: string): Record<string, number> {
  const total = Object.values(mix).reduce((acc, v) => acc + v, 0);
  if (!Number.isFinite(total) || total <= 0) {
    throw new Error(
      `usconnect: currency-of-life mix for ${personToken} must contain positive weights`
    );
  }
  const out: Record<string, number> = {};
  for (const [currency, weight] of Object.entries(mix)) {
    if (weight < 0)
      throw new Error(
        `usconnect: currency-of-life weight for ${personToken}/${currency} is negative`
      );
    out[currency] = weight / total;
  }
  return out;
}

function bandFor(score: number, rules: SharedRules): string {
  for (const band of rules.currencyOfLife.bands) {
    if (band.upTo === null || score <= band.upTo) return band.band;
  }
  throw new Error(
    "usconnect params: currency_of_life.bands must end with an open band (up_to: null)"
  );
}

function forPerson(
  person: Person,
  positions: Position[],
  rules: SharedRules,
  spending: Record<string, number> | undefined
): CurrencyOfLifePerson {
  const byCurrency = new Map<string, number>();
  let totalBase = 0;
  for (const position of positions) {
    const share = attributedShare(position, person.id);
    if (share === 0) continue;
    const value = position.valueBase * share;
    byCurrency.set(position.value.currency, (byCurrency.get(position.value.currency) ?? 0) + value);
    totalBase += value;
  }

  const portfolioMix: Record<string, number> = {};
  for (const [currency, value] of byCurrency)
    portfolioMix[currency] = totalBase === 0 ? 0 : value / totalBase;

  const spendingMix = spending ? normalise(spending, person.token) : null;
  const currencies = [
    ...new Set([...Object.keys(portfolioMix), ...Object.keys(spendingMix ?? {})]),
  ].sort();

  const rows: CurrencyRow[] = currencies.map((currency) => {
    const portfolioShare = portfolioMix[currency] ?? 0;
    const spendingShare = spendingMix ? (spendingMix[currency] ?? 0) : null;
    return {
      currency,
      portfolioShare,
      spendingShare,
      gap: spendingShare === null ? null : portfolioShare - spendingShare,
    };
  });

  // Total variation distance: half the sum of absolute share differences.
  const mismatchScore =
    spendingMix === null ? null : rows.reduce((acc, r) => acc + Math.abs(r.gap ?? 0), 0) / 2;

  return {
    personToken: person.token,
    totalBase,
    portfolioMix,
    spendingMix,
    rows,
    mismatchScore,
    band: mismatchScore === null ? null : bandFor(mismatchScore, rules),
  };
}

export function buildCurrencyOfLife(
  persons: Person[],
  positions: Position[],
  rules: SharedRules,
  spendingByPerson: Record<string, Record<string, number>> | undefined
): CurrencyOfLifeSection {
  return {
    method: rules.currencyOfLife.method,
    lookThrough: rules.currencyOfLife.lookThrough,
    lookThroughNote: rules.currencyOfLife.lookThroughNote,
    persons: persons.map((p) => forPerson(p, positions, rules, spendingByPerson?.[p.token])),
  };
}
