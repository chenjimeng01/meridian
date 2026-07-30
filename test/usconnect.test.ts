// SPEC §7 acceptance criteria, restated as tests before the module exists.
//
// Fixture household (test/fixtures/ledger/household-usuk-acceptance.json):
//   P1 = US citizen + UK resident.
//   A1 gia   — Sterling Park OEIC, Northgate OEIC, Atlas UCITS ETF,
//              Thames Utilities (UK share), Amalgamated Tech (US share),
//              Harbour Point (metadata_confirmed: false), GBP cash
//   A2 isa   — Sterling Park OEIC, GBP cash
//   A3 sipp  — Atlas UCITS ETF, GBP cash
//   A4 401k  — Pioneer S&P (US-registered), Keystone MMF (US-registered), USD cash
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { ROOT, readJson } from "./helpers.ts";
import { analyseUsConnect } from "../src/usconnect/index.ts";
import type { Ledger } from "../src/ingest/types.ts";

const usParams = readJson("params/us/2026.json");
const ukParams = readJson("params/uk/2026-27.json");
const pficRules = readJson("params/shared/pfic-rules.json");
const situsRules = readJson("params/shared/situs-rules.json");
const currencyOfLifeRules = readJson("params/shared/currency-of-life.json");
const wrapperMatrix = readJson("params/shared/wrapper-matrix.json");

const ASOF = "2026-06-30";
const GBPUSD = 1.28; // the fixture's only fx observation

/** Injected FX (SPEC §6: no rate lookups inside the module). */
function toBase(money: { amount: number; currency: string }): number {
  if (money.currency === "GBP") return money.amount;
  if (money.currency === "USD") return money.amount / GBPUSD;
  throw new Error(`test fx: unsupported currency ${money.currency}`);
}

function loadLedger(name: string): Ledger {
  return readJson(`test/fixtures/ledger/${name}.json`) as Ledger;
}

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

function analyse(ledger: Ledger, currencyOfLife?: Record<string, Record<string, number>>) {
  return analyseUsConnect({
    ledger,
    usParams,
    ukParams,
    pficRules,
    situsRules,
    currencyOfLifeRules,
    wrapperMatrix,
    asof: ASOF,
    toBase,
    ...(currencyOfLife ? { currencyOfLife } : {}),
  });
}

function acceptance() {
  const result = analyse(loadLedger("household-usuk-acceptance"));
  assert.ok(result, "acceptance household must produce a US-connected result");
  return result;
}

const EPS = 1e-6;
const near = (actual: number, expected: number, label: string) =>
  assert.ok(Math.abs(actual - expected) < EPS, `${label}: expected ~${expected}, got ${actual}`);

// ---------------------------------------------------------------- gating

test("§7 UK-only household produces no US module at all (null, not empty sections)", () => {
  assert.equal(analyse(loadLedger("household-uk-only")), null);
});

test("§7 module runs whenever any person is a US person", () => {
  const r = acceptance();
  assert.deepEqual(
    r.usPersons.map((p) => p.personToken),
    ["P1"]
  );
  assert.equal(r.asof, ASOF);
  assert.equal(r.baseCurrency, "GBP");
});

// ------------------------------------------------------------------ 7.1

/** All assessed positions keyed "ACCOUNT|instrument name". */
function pficByPosition(r: NonNullable<ReturnType<typeof analyse>>) {
  const map = new Map<string, (typeof r.pfic.holdings)[number]>();
  for (const h of r.pfic.holdings) map.set(`${h.accountToken}|${h.instrumentName}`, h);
  return map;
}

test("§7.1 every OEIC and the UCITS ETF are flagged PFIC", () => {
  const r = acceptance();
  const pos = pficByPosition(r);
  for (const key of [
    "A1|Sterling Park UK Equity Income OEIC Acc",
    "A1|Northgate UK Smaller Companies OEIC",
    "A1|Atlas Global Equity UCITS ETF",
    "A2|Sterling Park UK Equity Income OEIC Acc",
    "A3|Atlas Global Equity UCITS ETF",
  ]) {
    const h = pos.get(key);
    assert.ok(h, `missing assessed position ${key}`);
    assert.equal(h.outcome, "pfic", `${key} must be PFIC`);
    assert.ok(h.filingImplication, `${key}: Form 8621 filing implication required`);
    assert.ok(h.sources.length > 0, `${key}: sources required`);
    assert.ok(h.explanation.length > 20, `${key}: explanation block required`);
  }
  const flagged = new Set(r.pfic.flagged.map((h) => `${h.accountToken}|${h.instrumentName}`));
  assert.equal(flagged.size, 5, "exactly five PFIC positions");
});

test("§7.1 direct shares are not PFIC — UK or US incorporated", () => {
  const pos = pficByPosition(acceptance());
  for (const key of [
    "A1|Thames Utilities PLC Ordinary 25p",
    "A1|Amalgamated Tech Inc Common Stock",
  ]) {
    const h = pos.get(key);
    assert.ok(h, `missing ${key}`);
    assert.equal(h.outcome, "not_pfic", `${key} is a direct equity, not a pooled vehicle`);
    assert.equal(h.ruleId, "direct_security_or_cash");
  }
});

test("§7.1 US-registered ('40 Act) funds are not PFIC", () => {
  const pos = pficByPosition(acceptance());
  for (const key of ["A4|Pioneer S&P Index Fund", "A4|Keystone Treasury Money Market Fund"]) {
    const h = pos.get(key);
    assert.ok(h, `missing ${key}`);
    assert.equal(h.outcome, "not_pfic", `${key} is a US-registered fund`);
    assert.equal(h.ruleId, "us_registered_fund");
  }
});

test("§7.1 + S7 unconfirmed metadata routes to needs_classification, never to not-PFIC", () => {
  const r = acceptance();
  const h = pficByPosition(r).get("A1|Harbour Point Diversified Fund");
  assert.ok(h);
  assert.equal(h.outcome, "needs_classification");
  assert.equal(h.ruleId, "metadata_unconfirmed");
  assert.ok(
    r.pfic.needsClassification.some((n) => n.instrumentName === "Harbour Point Diversified Fund"),
    "Harbour Point must appear in the needs-classification list"
  );
  assert.ok(
    !r.pfic.flagged.some((n) => n.instrumentName === "Harbour Point Diversified Fund"),
    "needs_classification is not a PFIC flag"
  );
});

test("S7 a missing metadata_confirmed field is not authoritative either", () => {
  const ledger = clone(loadLedger("household-usuk-acceptance"));
  for (const inst of ledger.instruments) delete inst.metadata_confirmed;
  const r = analyse(ledger);
  assert.ok(r);
  assert.equal(r.pfic.flagged.length, 0, "nothing may be classified from unconfirmed metadata");
  assert.equal(r.pfic.needsClassification.length, r.pfic.holdings.length);
  for (const h of r.pfic.holdings) assert.equal(h.ruleId, "metadata_unconfirmed");
});

test("§7.1 wrapper mitigation: the same ETF is CRITICAL in the GIA and WARN in the SIPP", () => {
  const pos = pficByPosition(acceptance());
  const gia = pos.get("A1|Atlas Global Equity UCITS ETF");
  const sipp = pos.get("A3|Atlas Global Equity UCITS ETF");
  assert.ok(gia && sipp);
  assert.equal(gia.severity, "CRITICAL");
  assert.equal(gia.wrapperMitigation, null);
  assert.equal(
    sipp.outcome,
    "pfic",
    "the PFIC determination itself does not change inside a pension"
  );
  assert.equal(sipp.severity, "WARN");
  assert.ok(sipp.wrapperMitigation, "SIPP holding must carry wrapper context");
  assert.ok(sipp.wrapperMitigation.sources.length > 0);
});

test("§7.1 exposure summary: count, total value, % of investable wealth, all params-sourced", () => {
  const r = acceptance();
  const s = r.pfic.summary;
  assert.equal(s.positionCount, 5);
  assert.equal(s.instrumentCount, 3);
  near(s.totalValueBase, 161934.5, "PFIC total");
  near(
    s.investableWealthBase,
    109111.3 + 17869.12 + 75790 + 58308.55 / GBPUSD,
    "investable wealth"
  );
  near(s.shareOfInvestableWealth, s.totalValueBase / s.investableWealthBase, "share");
  assert.equal(s.needsClassificationCount, 1);
  near(s.needsClassificationValueBase, 10700, "unclassified value");

  const us = usParams as { params: { pfic: Record<string, { value: unknown } | undefined> } };
  assert.equal(r.pfic.reporting.form, us.params.pfic["form"]?.value);
  const deMinimis = us.params.pfic["de_minimis_reporting_exception"]?.value as Record<
    string,
    number
  >;
  assert.equal(r.pfic.reporting.deMinimis.thresholdAmount, deMinimis.aggregate_value_single);
  assert.equal(r.pfic.reporting.deMinimis.thresholdCurrency, "USD");
  assert.equal(r.pfic.reporting.deMinimis.belowThreshold, false);
  assert.ok(r.pfic.reporting.position.length > 20, "a stated reporting position is required");
  assert.ok(r.pfic.reporting.sources.length > 0);
});

// ------------------------------------------------------------------ 7.2

test("§7.2 wrapper map: ISA WARN, SIPP OK, one entry per distinct wrapper held", () => {
  const r = acceptance();
  const byWrapper = new Map(r.wrapperConflicts.map((w) => [w.wrapper, w]));
  assert.deepEqual([...byWrapper.keys()].sort(), ["401k", "gia", "isa", "sipp"]);
  assert.equal(byWrapper.get("isa")?.severity, "WARN");
  assert.equal(byWrapper.get("sipp")?.severity, "OK");
  for (const w of r.wrapperConflicts) {
    assert.ok(w.explanation.length > 20, `${w.wrapper}: explanation from params`);
    assert.ok(w.sources.length > 0, `${w.wrapper}: sources[] from params`);
    assert.ok(w.accountTokens.length > 0);
    assert.ok(w.ukResident, `${w.wrapper}: UK-resident perspective cell required`);
  }
  const matrix = (
    wrapperMatrix as {
      matrix: Record<string, { us_person: { severity: string; explanation: string } }>;
    }
  ).matrix;
  assert.equal(
    byWrapper.get("isa")?.explanation,
    matrix.isa?.us_person.explanation,
    "text must come from params"
  );
});

test("§8 the section opens with a count of critical flags", () => {
  const r = acceptance();
  const criticalPfic = r.pfic.holdings.filter((h) => h.severity === "CRITICAL").length;
  const criticalWrappers = r.wrapperConflicts.filter((w) => w.severity === "CRITICAL").length;
  assert.equal(r.criticalCount, criticalPfic + criticalWrappers);
  assert.equal(criticalPfic, 4, "GIA OEICs + GIA ETF + ISA OEIC");
  assert.equal(criticalWrappers, 0, "no UK bonds in this household");
});

// ------------------------------------------------------------------ 7.3

test("§7.3 situs splits US and non-US correctly, and follows incorporation not custody", () => {
  const r = acceptance();
  assert.equal(r.situs.persons.length, 1);
  const p = r.situs.persons[0];
  assert.ok(p);
  const key = (i: { accountToken: string; instrumentName: string }) =>
    `${i.accountToken}|${i.instrumentName}`;
  const usSitus = new Set(p.usSitus.items.map(key));
  const nonUs = new Set(p.nonUsSitus.items.map(key));

  // The 401(k) — all of it — and the US-incorporated share.
  for (const k of [
    "A4|Pioneer S&P Index Fund",
    "A4|Keystone Treasury Money Market Fund",
    "A4|Cash (USD)",
    "A1|Amalgamated Tech Inc Common Stock",
  ]) {
    assert.ok(usSitus.has(k), `${k} must be US-situs`);
    assert.ok(!nonUs.has(k), `${k} must not also be non-US-situs`);
  }
  // Situs follows incorporation, not custody: the US share sits in a UK GIA.
  const amalgamated = p.usSitus.items.find(
    (i) => i.instrumentName === "Amalgamated Tech Inc Common Stock"
  );
  assert.ok(amalgamated);
  assert.equal(amalgamated.wrapper, "gia", "held in a UK general investment account");
  assert.equal(amalgamated.wrapperJurisdiction, "UK");
  assert.equal(amalgamated.assetClass, "us_incorporated_stock");

  for (const k of [
    "A1|Sterling Park UK Equity Income OEIC Acc",
    "A1|Northgate UK Smaller Companies OEIC",
    "A1|Atlas Global Equity UCITS ETF",
    "A1|Thames Utilities PLC Ordinary 25p",
    "A1|Cash (GBP)",
    "A2|Sterling Park UK Equity Income OEIC Acc",
    "A3|Atlas Global Equity UCITS ETF",
  ]) {
    assert.ok(nonUs.has(k), `${k} must be non-US-situs`);
    assert.ok(!usSitus.has(k), `${k} must not also be US-situs`);
  }

  near(p.usSitus.totalBase, 15156 + 58308.55 / GBPUSD, "US-situs total");
  near(p.nonUsSitus.totalBase, 176914.42, "non-US-situs total");
  near(p.unclassified.totalBase, 10700, "unconfirmed metadata is not silently classified");
});

test("§7.3 estate scope, treaty credit and the not-advice label are explicit", () => {
  const r = acceptance();
  const p = r.situs.persons[0];
  assert.ok(p);
  assert.equal(p.usEstate.basis, "worldwide", "P1 is a US citizen");
  const estate = (
    usParams as { params: { estate_gift: Record<string, { value: number } | undefined> } }
  ).params.estate_gift;
  assert.equal(p.usEstate.exemptionUsd, estate["estate_exemption"]?.value);
  assert.equal(
    p.usEstate.nonresidentExemptionUsd,
    estate["nonresident_alien_exemption_equivalent"]?.value
  );
  assert.equal(p.ukIht.scope, "worldwide", "ltr_flag: UK long-term resident");
  assert.ok(p.ukIht.sources.length > 0);

  assert.match(r.situs.label, /exposure sketch — not advice/i);
  assert.ok(r.situs.treatyCredit.note.length > 20);
  assert.ok(r.situs.treatyCredit.sources.length > 0);
  assert.ok(
    r.assumptions.some((a) => /treaty credit/i.test(a.assumption)),
    "the treaty credit must be recorded as an explicit modelling assumption"
  );
});

// ------------------------------------------------------------------ 7.4

test("§7.4 currency-of-life compares portfolio exposure with the spending mix", () => {
  const r = analyse(loadLedger("household-usuk-acceptance"), { P1: { GBP: 0.8, USD: 0.2 } });
  assert.ok(r);
  const p = r.currencyOfLife.persons[0];
  assert.ok(p);
  const total = 109111.3 + 17869.12 + 75790 + 58308.55 / GBPUSD;
  const usdShare = 58308.55 / GBPUSD / total;
  near(p.portfolioMix.USD ?? 0, usdShare, "USD portfolio share");
  near(p.portfolioMix.GBP ?? 0, 1 - usdShare, "GBP portfolio share");
  assert.ok(p.spendingMix);
  near(
    p.mismatchScore ?? -1,
    Math.abs(1 - usdShare - 0.8),
    "mismatch score (total variation distance)"
  );
  assert.ok(p.mismatchScore !== null && p.mismatchScore >= 0 && p.mismatchScore <= 1);
  assert.equal(p.band, "aligned");
  assert.ok(r.currencyOfLife.method.length > 20, "the score must be documented");
  const row = p.rows.find((x) => x.currency === "USD");
  assert.ok(row);
  near(row.gap ?? NaN, usdShare - 0.2, "per-currency gap");
});

test("§7.4 with no operator-set spending mix the score is null, not zero", () => {
  const r = acceptance();
  const p = r.currencyOfLife.persons[0];
  assert.ok(p);
  assert.equal(p.spendingMix, null);
  assert.equal(p.mismatchScore, null);
  assert.equal(p.band, null);
});

test("§7.3 a non-US joint owner gets the NRA column treatment and an equal split", () => {
  const ledger = clone(loadLedger("household-usuk-acceptance"));
  const p1 = ledger.household.persons[0];
  assert.ok(p1);
  ledger.household.persons.push({
    id: "01MERACPT00000000000000099",
    display_token: "P2",
    tax_profile: { uk_resident: true, uk_domicile_status: "not_ltr", us_person: false },
  });
  const gia = ledger.accounts.find((a) => a.account_token === "A1")!;
  gia.person_ids = [p1.id, "01MERACPT00000000000000099"];

  const r = analyse(ledger);
  assert.ok(r);
  assert.deepEqual(
    r.situs.persons.map((p) => p.personToken),
    ["P1", "P2"]
  );
  const p2 = r.situs.persons[1];
  assert.ok(p2);
  assert.equal(p2.usPerson, false);
  assert.equal(p2.usEstate.basis, "us_situs_only", "an NRA is exposed on US-situs assets only");
  assert.equal(p2.ukIht.scope, "uk_situs_only", "not flagged as a UK long-term resident");
  // Half of the US share in the joint GIA, and none of the solely-owned accounts.
  near(p2.usSitus.totalBase, 15156 / 2, "NRA US-situs exposure");
  const amalgamated = p2.usSitus.items.find(
    (i) => i.instrumentName === "Amalgamated Tech Inc Common Stock"
  );
  assert.equal(amalgamated?.attributedShare, 0.5);
  assert.equal(p2.unclassified.totalBase, 10700 / 2);
  // The PFIC population still keys on the US person, so the joint GIA stays in it.
  assert.equal(r.pfic.summary.positionCount, 5);
  assert.ok(
    r.assumptions.some((a) => a.id === "situs_attribution" && /equally/i.test(a.assumption)),
    "the equal-split attribution must be a stated assumption"
  );
});

// ------------------------------------------------------------- discipline

test("module is deterministic: same inputs, byte-identical result", () => {
  const a = analyse(loadLedger("household-usuk-acceptance"), { P1: { GBP: 0.8, USD: 0.2 } });
  const b = analyse(loadLedger("household-usuk-acceptance"), { P1: { GBP: 0.8, USD: 0.2 } });
  assert.equal(JSON.stringify(a), JSON.stringify(b));
});

test("no clock, no randomness, no env, no tax literals hiding in src/usconnect", () => {
  const dir = join(ROOT, "src/usconnect");
  const files = readdirSync(dir).filter((f) => f.endsWith(".ts"));
  assert.ok(files.length >= 4, "module is split into focused files");
  for (const f of files) {
    const src = readFileSync(join(dir, f), "utf8");
    assert.doesNotMatch(src, /new Date\(|Date\.now\(|Math\.random\(|process\.env/, `${f}: impure`);
    assert.ok(src.split("\n").length < 500, `${f}: over 500 lines`);
  }
});
