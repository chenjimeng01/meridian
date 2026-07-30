// Flattens the ledger into the one shape every §7 sub-module needs: a holding
// joined to its account and instrument, valued in base currency by the injected
// FX function. Pure; the ledger's own array order is preserved so output is
// stable without sorting.
import type { Ledger } from "../ingest/types.ts";
import type { Money } from "./types.ts";
import type { RuleSubject } from "./params.ts";

export type ToBase = (money: Money, asof: string) => number;

export interface Person {
  id: string;
  token: string;
  usPerson: boolean;
  usPersonBasis: string | null;
  ukResident: boolean;
  ukDomicileStatus: string | null;
}

export interface Position {
  accountId: string;
  accountToken: string;
  wrapper: string;
  wrapperJurisdiction: string;
  personIds: string[];
  personTokens: string[];
  instrumentId: string;
  instrumentName: string;
  instrumentType: string;
  domicile: string | null;
  metadataConfirmed: boolean;
  usRegistered: boolean;
  hmrcReportingFund: boolean;
  value: Money;
  valueBase: number;
}

export interface Wrapper {
  wrapper: string;
  wrapperJurisdiction: string;
  accountTokens: string[];
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

export function readPersons(ledger: Ledger): Person[] {
  return ledger.household.persons.map((p) => {
    const profile = p.tax_profile;
    return {
      id: p.id,
      token: p.display_token,
      usPerson: profile["us_person"] === true,
      usPersonBasis: str(profile["us_person_basis"]),
      ukResident: profile["uk_resident"] === true,
      ukDomicileStatus: str(profile["uk_domicile_status"]),
    };
  });
}

/** Every distinct wrapper the household holds, in ledger account order. */
export function readWrappers(ledger: Ledger): Wrapper[] {
  const out = new Map<string, Wrapper>();
  for (const account of ledger.accounts) {
    const wrapper = String(account.wrapper);
    const existing = out.get(wrapper);
    if (existing) {
      existing.accountTokens.push(String(account.account_token));
    } else {
      out.set(wrapper, {
        wrapper,
        wrapperJurisdiction: String(account.wrapper_jurisdiction),
        accountTokens: [String(account.account_token)],
      });
    }
  }
  return [...out.values()];
}

export function buildPositions(ledger: Ledger, toBase: ToBase, asof: string): Position[] {
  const accounts = new Map<string, Record<string, unknown>>();
  for (const a of ledger.accounts) accounts.set(String(a.id), a as unknown as Record<string, unknown>);
  const instruments = new Map<string, Record<string, unknown>>();
  for (const i of ledger.instruments) instruments.set(String(i.id), i as unknown as Record<string, unknown>);
  const personTokens = new Map<string, string>();
  for (const p of ledger.household.persons) personTokens.set(p.id, p.display_token);

  return ledger.holdings.map((holding, index) => {
    const account = accounts.get(String(holding.account_id));
    if (!account)
      throw new Error(
        `usconnect: holding[${index}] references unknown account ${holding.account_id}`
      );
    const instrument = instruments.get(String(holding.instrument_id));
    if (!instrument)
      throw new Error(
        `usconnect: holding[${index}] references unknown instrument ${holding.instrument_id}`
      );

    const rawValue = holding.value as { amount?: unknown; currency?: unknown } | undefined;
    if (typeof rawValue?.amount !== "number" || typeof rawValue.currency !== "string") {
      throw new Error(`usconnect: holding[${index}] has no { amount, currency } value`);
    }
    const value: Money = { amount: rawValue.amount, currency: rawValue.currency };
    const valueBase = toBase(value, asof);
    if (!Number.isFinite(valueBase)) {
      throw new Error(
        `usconnect: injected FX returned a non-finite base value for ${value.currency} at ${asof}`
      );
    }

    const personIds = ((account["person_ids"] as unknown[] | undefined) ?? []).map(String);
    return {
      accountId: String(account["id"]),
      accountToken: String(account["account_token"]),
      wrapper: String(account["wrapper"]),
      wrapperJurisdiction: String(account["wrapper_jurisdiction"]),
      personIds,
      personTokens: personIds.map((id) => personTokens.get(id) ?? id),
      instrumentId: String(instrument["id"]),
      instrumentName: String(instrument["name"]),
      instrumentType: String(instrument["type"]),
      domicile: str(instrument["domicile"]),
      metadataConfirmed: instrument["metadata_confirmed"] === true,
      usRegistered: instrument["us_registered"] === true,
      hmrcReportingFund: instrument["hmrc_reporting_fund"] === true,
      value,
      valueBase,
    };
  });
}

/** The facts a params `when` clause is evaluated against. */
export function subjectOf(position: Position): RuleSubject {
  return {
    type: position.instrumentType,
    domicile: position.domicile,
    wrapper: position.wrapper,
    metadata_confirmed: position.metadataConfirmed,
    us_registered: position.usRegistered,
    hmrc_reporting_fund: position.hmrcReportingFund,
  };
}

/**
 * Share of a position attributable to one person. Joint accounts split equally
 * (params: situs.attribution) — beneficial ownership is not in the ledger.
 */
export function attributedShare(position: Position, personId: string): number {
  if (!position.personIds.includes(personId)) return 0;
  return 1 / position.personIds.length;
}

export function heldForAnyOf(position: Position, personIds: Set<string>): boolean {
  return position.personIds.some((id) => personIds.has(id));
}
