#!/usr/bin/env node
// Generates the two Phase 3 test households (SPEC §7 acceptance criteria):
//
//   household-usuk-acceptance.json — "US-citizen partner at a London law firm,
//     GIA of UK OEICs + ISA + SIPP + US 401(k)", plus direct UK and US shares
//     and one deliberately unconfirmed instrument (PHASE_REVIEW_2 S7).
//   household-uk-only.json — a UK-only household; Module 3 must produce
//     nothing at all for it, not empty sections.
//
// ALL data is fictional (see NOTICE). Deterministic: no clock, no RNG.
// Usage: node scripts/gen-engine-fixtures.mjs [output-dir]
import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = process.argv[2] ?? join(ROOT, "test", "fixtures", "ledger");

const r2 = (x) => Math.round(x * 100) / 100;
const ASOF = "2026-06-30";
const PARSED_AT = "2026-07-30T11:00:00Z";
const ACCEPTED_AT = "2026-07-30T12:00:00Z";

function makeLedger({ prefix, persons, accounts, instruments, secondary }) {
  let n = 0;
  const id = () => prefix + String(++n).padStart(26 - prefix.length, "0");

  const personRecords = persons.map((p) => ({ id: id(), display_token: p.token, tax_profile: p.tax_profile }));
  const personIdByToken = new Map(personRecords.map((p, i) => [persons[i].token, p.id]));

  const instrumentRecords = {};
  for (const [key, inst] of Object.entries(instruments)) {
    instrumentRecords[key] = {
      id: id(),
      identifiers: inst.identifiers ?? {},
      name: inst.name,
      type: inst.type,
      ...(inst.domicile ? { domicile: inst.domicile } : {}),
      ...(inst.hmrc_reporting_fund !== undefined ? { hmrc_reporting_fund: inst.hmrc_reporting_fund } : {}),
      ...(inst.us_registered !== undefined ? { us_registered: inst.us_registered } : {}),
      pfic_status: "not_assessed",
      metadata_confirmed: inst.metadata_confirmed !== false,
      prices: [],
    };
  }

  const docId = id();
  const accountRecords = [];
  const holdings = [];
  const acceptanceLines = [];

  for (const acct of accounts) {
    const record = {
      id: id(),
      person_ids: acct.owners.map((t) => personIdByToken.get(t)),
      institution: acct.institution,
      account_token: acct.token,
      wrapper: acct.wrapper,
      wrapper_jurisdiction: acct.jurisdiction,
      custody_currency: acct.currency,
      opened: null,
      data_asof: ASOF,
    };
    accountRecords.push(record);
    for (const [key, units, price] of acct.holdings) {
      const inst = instrumentRecords[key];
      const value = { amount: r2(units * price), currency: acct.currency };
      holdings.push({
        account_id: record.id,
        instrument_id: inst.id,
        asof: ASOF,
        units,
        value,
        source_document_id: docId,
      });
      inst.prices.push({ date: ASOF, price: { amount: price, currency: acct.currency }, source: "statement" });
      acceptanceLines.push({ kind: "holding", account_token: acct.token, ref: inst.name, action: "accepted", instrument_id: inst.id });
    }
  }

  return {
    schema_version: "0.1",
    household: {
      id: id(),
      base_currency: "GBP",
      ...(secondary ? { secondary_currency: secondary } : {}),
      persons: personRecords,
    },
    accounts: accountRecords,
    instruments: Object.values(instrumentRecords),
    holdings,
    transactions: [],
    documents: [
      {
        id: docId,
        filename: "synthetic/engine-fixture.txt",
        sha256: "0".repeat(64),
        institution: "Synthetic Fixture",
        doc_type: "valuation",
        period: { from: "2026-04-01", to: ASOF },
        parsed_at: PARSED_AT,
        accepted_at: ACCEPTED_AT,
        parse_run_ids: ["RUN-ENGINE-01"],
      },
    ],
    acceptances: [
      {
        id: id(),
        document_id: docId,
        parse_run_id: "RUN-ENGINE-01",
        accepted_at: ACCEPTED_AT,
        operator_initials: "JC",
        lines: acceptanceLines,
      },
    ],
    fx_rates: [{ date: ASOF, pair: "GBPUSD", rate: 1.28, source: "statement:synthetic/engine-fixture" }],
  };
}

// ---------------------------------------------------------------------------
// §7 acceptance household
// ---------------------------------------------------------------------------
const acceptance = makeLedger({
  prefix: "01MERACPT0",
  secondary: "USD",
  persons: [
    {
      token: "P1",
      tax_profile: {
        uk_resident: true,
        uk_domicile_status: "ltr_flag",
        us_person: true,
        us_person_basis: "citizen",
        state_exposure: "NY",
        treaty_positions: ["uk_us_dta_pension_art17_18"],
      },
    },
  ],
  instruments: {
    // Non-US pooled → PFIC CRITICAL
    spOeic: { name: "Sterling Park UK Equity Income OEIC Acc", type: "oeic", domicile: "GB", identifiers: { isin: "GB00SYNTH014" }, hmrc_reporting_fund: true, us_registered: false },
    northgate: { name: "Northgate UK Smaller Companies OEIC", type: "oeic", domicile: "GB", identifiers: { isin: "GB00SYNTH089" }, hmrc_reporting_fund: true, us_registered: false },
    atlasEtf: { name: "Atlas Global Equity UCITS ETF", type: "ucits_etf", domicile: "IE", identifiers: { isin: "IE00SYNTH021" }, hmrc_reporting_fund: true, us_registered: false },
    // Direct securities → NOT PFIC
    thames: { name: "Thames Utilities PLC Ordinary 25p", type: "equity", domicile: "GB", identifiers: { isin: "GB00SYNTH052" } },
    amalgamated: { name: "Amalgamated Tech Inc Common Stock", type: "equity", domicile: "US", identifiers: { isin: "US0000SYN047", cusip: "SYN000104" } },
    // US-registered funds → NOT PFIC
    pioneer: { name: "Pioneer S&P Index Fund", type: "mutual_fund_us", domicile: "US", identifiers: { isin: "US0000SYN039" }, us_registered: true, hmrc_reporting_fund: false },
    keystone: { name: "Keystone Treasury Money Market Fund", type: "mmf", domicile: "US", identifiers: { isin: "US0000SYN070" }, us_registered: true, hmrc_reporting_fund: false },
    // Metadata never confirmed → needs_classification, NOT a silent downgrade
    harbourPoint: { name: "Harbour Point Diversified Fund", type: "other_pooled", domicile: "JE", identifiers: {}, metadata_confirmed: false },
    cashGbp: { name: "Cash (GBP)", type: "cash", identifiers: {} },
    cashUsd: { name: "Cash (USD)", type: "cash", identifiers: {} },
  },
  accounts: [
    {
      token: "A1", owners: ["P1"], institution: "Alderbrook Platform", wrapper: "gia",
      jurisdiction: "UK", currency: "GBP",
      holdings: [
        ["spOeic", 12500, 2.221],
        ["northgate", 4000, 3.415],
        ["atlasEtf", 450, 65.02],
        ["thames", 1800, 6.31],
        ["amalgamated", 90, 168.4],
        ["harbourPoint", 250, 42.8],
        ["cashGbp", 1215.8, 1],
      ],
    },
    {
      token: "A2", owners: ["P1"], institution: "Alderbrook Platform", wrapper: "isa",
      jurisdiction: "UK", currency: "GBP",
      holdings: [["spOeic", 8000, 2.221], ["cashGbp", 101.12, 1]],
    },
    {
      token: "A3", owners: ["P1"], institution: "Beacon SIPP Trustees", wrapper: "sipp",
      jurisdiction: "UK", currency: "GBP",
      holdings: [["atlasEtf", 1150, 63.9], ["cashGbp", 2305, 1]],
    },
    {
      token: "A4", owners: ["P1"], institution: "Liberty Street Retirement", wrapper: "401k",
      jurisdiction: "US", currency: "USD",
      holdings: [["pioneer", 300, 152.35], ["keystone", 12451.15, 1], ["cashUsd", 152.4, 1]],
    },
  ],
});

// ---------------------------------------------------------------------------
// UK-only household — Module 3 must be silently absent
// ---------------------------------------------------------------------------
const ukOnly = makeLedger({
  prefix: "01MERDMST0",
  persons: [{ token: "P1", tax_profile: { uk_resident: true, uk_domicile_status: "ltr_flag", us_person: false } }],
  instruments: {
    spOeic: { name: "Sterling Park UK Equity Income OEIC Acc", type: "oeic", domicile: "GB", identifiers: { isin: "GB00SYNTH014" }, hmrc_reporting_fund: true, us_registered: false },
    thames: { name: "Thames Utilities PLC Ordinary 25p", type: "equity", domicile: "GB", identifiers: { isin: "GB00SYNTH052" } },
    cashGbp: { name: "Cash (GBP)", type: "cash", identifiers: {} },
  },
  accounts: [
    {
      token: "A1", owners: ["P1"], institution: "Alderbrook Platform", wrapper: "gia",
      jurisdiction: "UK", currency: "GBP",
      holdings: [["spOeic", 10000, 2.221], ["thames", 1200, 6.31]],
    },
    {
      token: "A2", owners: ["P1"], institution: "Alderbrook Platform", wrapper: "isa",
      jurisdiction: "UK", currency: "GBP",
      holdings: [["spOeic", 5000, 2.221], ["cashGbp", 480.5, 1]],
    },
  ],
});

// ---------------------------------------------------------------------------
// FX date-mismatch household (SPEC §6 acceptance criterion c, PHASE_REVIEW_3 M1)
// Deliberately awkward: NO rate is dated on any valuation date, one leg is
// stale enough to warn, one currency has no direct pair and must triangulate,
// and holdings are valued on two different dates.
// ---------------------------------------------------------------------------
const fxMismatch = (() => {
  const prefix = "01MERFXMM0";
  let n = 0;
  const id = () => prefix + String(++n).padStart(26 - prefix.length, "0");
  const personId = id();
  const docId = id();
  const accountId = id();
  const olderAccountId = id();
  const instruments = [
    { key: "gbpFund", name: "Northgate UK Smaller Companies OEIC", type: "oeic", domicile: "GB", currency: "GBP", units: 10000, price: 1, asof: "2026-06-30" },
    { key: "usdFund", name: "Pioneer S&P Index Fund", type: "mutual_fund_us", domicile: "US", currency: "USD", units: 12800, price: 1, asof: "2026-06-30" },
    { key: "eurFund", name: "Continental Europe Equity SICAV", type: "other_pooled", domicile: "LU", currency: "EUR", units: 5400, price: 1, asof: "2026-06-30" },
    // In a SECOND account: a statement is a complete picture of its own
    // account, so two valuation dates within one account would mean the older
    // position had been sold. Different accounts reporting on different dates
    // is the real-world case, and is what makes the FX dates mismatch.
    { key: "oldUsd", name: "Keystone Treasury Money Market Fund", type: "mmf", domicile: "US", currency: "USD", units: 2500, price: 1, asof: "2026-02-15", account: "older" },
  ].map((i) => ({ ...i, id: id() }));

  return {
    schema_version: "0.1",
    household: {
      id: id(),
      base_currency: "GBP",
      secondary_currency: "USD",
      persons: [{ id: personId, display_token: "P1", tax_profile: { uk_resident: true, us_person: false } }],
    },
    accounts: [
      {
        id: accountId, person_ids: [personId], institution: "Alderbrook Platform",
        account_token: "A1", wrapper: "gia", wrapper_jurisdiction: "UK",
        custody_currency: "GBP", opened: null, data_asof: "2026-06-30",
      },
      {
        id: olderAccountId, person_ids: [personId], institution: "Liberty Street Securities",
        account_token: "A2", wrapper: "us_brokerage", wrapper_jurisdiction: "US",
        custody_currency: "USD", opened: null, data_asof: "2026-02-15",
      },
    ],
    instruments: instruments.map((i) => ({
      id: i.id, identifiers: {}, name: i.name, type: i.type, domicile: i.domicile,
      pfic_status: "not_assessed", metadata_confirmed: true,
      prices: [{ date: i.asof, price: { amount: i.price, currency: i.currency }, source: "statement" }],
    })),
    holdings: instruments.map((i) => ({
      account_id: i.account === "older" ? olderAccountId : accountId,
      instrument_id: i.id, asof: i.asof, units: i.units,
      value: { amount: r2(i.units * i.price), currency: i.currency },
      source_document_id: docId,
    })),
    transactions: [],
    documents: [
      {
        id: docId, filename: "synthetic/fx-mismatch.txt", sha256: "1".repeat(64),
        institution: "Synthetic Fixture", doc_type: "valuation",
        period: { from: "2026-01-01", to: "2026-06-30" },
        parsed_at: PARSED_AT, accepted_at: ACCEPTED_AT, parse_run_ids: ["RUN-FX-01"],
      },
    ],
    acceptances: [
      {
        id: id(), document_id: docId, parse_run_id: "RUN-FX-01",
        accepted_at: ACCEPTED_AT, operator_initials: "JC",
        lines: instruments.map((i) => ({ kind: "holding", account_token: i.account === "older" ? "A2" : "A1", ref: i.name, action: "accepted", instrument_id: i.id })),
      },
    ],
    // No rate lands on 2026-06-30 or 2026-02-15, and GBPEUR is never quoted.
    fx_rates: [
      { date: "2026-01-31", pair: "GBPUSD", rate: 1.25, source: "statement:synthetic/fx-mismatch" },
      { date: "2026-06-10", pair: "GBPUSD", rate: 1.28, source: "statement:synthetic/fx-mismatch" },
      { date: "2026-06-10", pair: "EURUSD", rate: 1.08, source: "statement:synthetic/fx-mismatch" },
    ],
  };
})();

mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, "household-usuk-acceptance.json"), JSON.stringify(acceptance, null, 2) + "\n");
writeFileSync(join(OUT, "household-uk-only.json"), JSON.stringify(ukOnly, null, 2) + "\n");
writeFileSync(join(OUT, "household-fx-mismatch.json"), JSON.stringify(fxMismatch, null, 2) + "\n");
console.log(
  `Wrote acceptance household (${acceptance.accounts.length} accounts, ${acceptance.holdings.length} holdings) ` +
    `and UK-only household (${ukOnly.accounts.length} accounts, ${ukOnly.holdings.length} holdings) to ${OUT}`
);
