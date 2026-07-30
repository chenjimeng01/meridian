import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, readJson } from "./helpers.ts";
import { createVault } from "../src/ingest/redact.ts";
import { initHousehold, acceptRun } from "../src/ingest/accept.ts";
import { executeParseRun } from "../src/ingest/run.ts";
import { sequentialIds } from "../src/ingest/ids.ts";
import { INGEST_ORDER } from "../src/ingest/order.ts";
import { analyseUsConnect } from "../src/usconnect/index.ts";
import { convert } from "../src/engine/fx.ts";
import type { LineRef, MetadataConfirmation } from "../src/ingest/types.ts";

// PHASE_REVIEW_3 S13: the PFIC cascade is gated on `metadata_confirmed`, and
// nothing in the pipeline could set it — so a REAL ingested ledger produced no
// PFIC flags at all, with everything routed to needs_classification. §7 only
// ever worked on the hand-authored acceptance fixture. These tests drive the
// genuine ingest path end to end.

const config = readJson("test/fixtures/household-config.json") as any;
const fxPolicy = readJson("params/shared/fx-policy.json");
const PARSED_AT = "2026-07-30T11:00:00Z";
const ACCEPTED_AT = "2026-07-30T12:00:00Z";

/** What an operator would confirm for each fixture instrument at review time. */
const OPERATOR_KNOWLEDGE: Record<string, MetadataConfirmation> = {
  "Sterling Park UK Equity Income OEIC Acc": { type: "oeic", domicile: "GB", us_registered: false, hmrc_reporting_fund: true },
  "Atlas Global Equity UCITS ETF": { type: "ucits_etf", domicile: "IE", us_registered: false, hmrc_reporting_fund: true },
  "Thames Utilities PLC Ordinary 25p": { type: "equity", domicile: "GB", us_registered: false },
  "Amalgamated Tech Inc Common Stock": { type: "equity", domicile: "US", us_registered: false },
  "Continental Rail Corp Common Stock": { type: "equity", domicile: "US", us_registered: false },
  "UK Treasury Gilt 4.25% 2032": { type: "bond", domicile: "GB", us_registered: false },
  "Pioneer S&P Index Fund": { type: "mutual_fund_us", domicile: "US", us_registered: true },
  "Keystone Treasury Money Market Fund": { type: "mmf", domicile: "US", us_registered: true },
};

function ingest(confirmMetadata: boolean) {
  const ids = sequentialIds();
  const vault = createVault(config, "fixture-salt");
  const ledger = initHousehold(config, ids);
  const decide = (line: LineRef) => {
    const confirmation = confirmMetadata && line.kind === "holding" ? OPERATOR_KNOWLEDGE[line.ref] : undefined;
    return confirmation ? { action: "accept" as const, confirmMetadata: confirmation } : { action: "accept" as const };
  };
  for (const rel of INGEST_ORDER) {
    const rawText = readFileSync(join(ROOT, "test/fixtures/statements", rel), "utf8");
    const run = executeParseRun({ rawText, filename: rel, ledger, vault, ids, createdAt: PARSED_AT });
    acceptRun(ledger, run, config, ids, { acceptedAt: ACCEPTED_AT, operatorInitials: "JC", decide });
  }
  return ledger;
}

function analyse(ledger: any) {
  return analyseUsConnect({
    ledger,
    usParams: readJson("params/us/2026.json"),
    ukParams: readJson("params/uk/2026-27.json"),
    pficRules: readJson("params/shared/pfic-rules.json"),
    situsRules: readJson("params/shared/situs-rules.json"),
    currencyOfLifeRules: readJson("params/shared/currency-of-life.json"),
    wrapperMatrix: readJson("params/shared/wrapper-matrix.json"),
    asof: "2026-06-30",
    toBase: (m, asof) => convert(m, "GBP", asof, { rates: ledger.fx_rates, policy: fxPolicy }).exact,
  });
}

test("without confirmation the real ingest path classifies nothing — the conservative default", () => {
  const ledger = ingest(false);
  assert.ok(
    ledger.instruments.filter((i) => i.type !== "cash").every((i) => i.metadata_confirmed !== true),
    "ingest may never assert confirmation for an instrument it read off a document"
  );

  const result = analyse(ledger)!;
  assert.ok(result, "the household has a US person, so the module must run");
  // Cash is excluded: the pipeline creates it from an explicit balance line, so
  // its type is a fact rather than an inference and there is nothing for an
  // operator to confirm. The guarantee is about instruments read off a document.
  const inferred = result.pfic.holdings.filter((h: any) => !h.instrumentName.startsWith("Cash ("));
  assert.ok(inferred.length > 0, "guard: there are instruments whose type was inferred");
  const outcomes = new Set(inferred.map((h: any) => h.outcome));
  assert.deepEqual([...outcomes], ["needs_classification"], "everything inferred must be referred, not silently cleared");
  assert.equal(
    inferred.some((h: any) => h.outcome === "not_pfic"),
    false,
    "nothing may be declared safe on inferred metadata"
  );
});

test("once the operator confirms metadata, the real ingest path produces the PFIC flags (§7.1)", () => {
  const ledger = ingest(true);
  const result = analyse(ledger)!;

  const flagged = [...new Set(result.pfic.holdings.filter((h: any) => h.outcome === "pfic").map((h: any) => h.instrumentName))].sort();
  assert.deepEqual(flagged, ["Atlas Global Equity UCITS ETF", "Sterling Park UK Equity Income OEIC Acc"]);

  const notPfic = (name: string) =>
    result.pfic.holdings.filter((h: any) => h.instrumentName === name).every((h: any) => h.outcome === "not_pfic");
  assert.ok(notPfic("Thames Utilities PLC Ordinary 25p"), "direct UK share");
  assert.ok(notPfic("Amalgamated Tech Inc Common Stock"), "direct US share");
  assert.ok(notPfic("UK Treasury Gilt 4.25% 2032"), "direct bond");
  assert.ok(notPfic("Pioneer S&P Index Fund"), "'40 Act fund, once the operator confirms registration");
  assert.ok(notPfic("Keystone Treasury Money Market Fund"), "'40 Act money-market fund");

  assert.ok(result.criticalCount > 0, "§8 opens the US section with a critical count that must be real");
});

test("the same fund is CRITICAL in the GIA/ISA but WARN inside the SIPP (§7.1 wrapper mitigation)", () => {
  const result = analyse(ingest(true))!;
  const atlas = result.pfic.holdings.filter((h: any) => h.instrumentName === "Atlas Global Equity UCITS ETF");
  const byWrapper = Object.fromEntries(atlas.map((h: any) => [h.wrapper, h.severity]));
  assert.equal(byWrapper.gia, "CRITICAL");
  assert.equal(byWrapper.sipp, "WARN", "treaty-recognised pension mitigates severity but not the PFIC finding");
  assert.ok(atlas.every((h: any) => h.outcome === "pfic"), "the determination itself does not change with the wrapper");
});

test("a US-registered fund is only cleared because the operator said so, not because it looked American", () => {
  // Confirm everything EXCEPT the '40 Act registration of the US funds.
  const ids = sequentialIds();
  const vault = createVault(config, "fixture-salt");
  const ledger = initHousehold(config, ids);
  const decide = (line: LineRef) => {
    if (line.kind !== "holding") return { action: "accept" as const };
    const known = OPERATOR_KNOWLEDGE[line.ref];
    if (!known) return { action: "accept" as const };
    const withoutRegistration = { ...known };
    delete withoutRegistration.us_registered;
    return { action: "accept" as const, confirmMetadata: withoutRegistration };
  };
  for (const rel of INGEST_ORDER) {
    const rawText = readFileSync(join(ROOT, "test/fixtures/statements", rel), "utf8");
    const run = executeParseRun({ rawText, filename: rel, ledger, vault, ids, createdAt: PARSED_AT });
    acceptRun(ledger, run, config, ids, { acceptedAt: ACCEPTED_AT, operatorInitials: "JC", decide });
  }

  const result = analyse(ledger)!;
  const pioneer = result.pfic.holdings.find((h: any) => h.instrumentName === "Pioneer S&P Index Fund")!;
  // US-domiciled so it is not caught by the non-US pooled rule, but without
  // confirmed '40 Act registration it cannot be cleared either — the cascade's
  // catch-all refers it rather than guessing.
  assert.equal(pioneer.outcome, "needs_classification");
});

// Regression: Module 3 read every holding row rather than the latest snapshot
// per position, so a ledger with three statements per account counted each
// holding three times — investable wealth read £1,265,902 against an actual
// £442,559, and the critical-flag count tripled. Only a multi-snapshot ledger
// exposes it; the single-date acceptance fixture cannot.
test("PFIC exposure counts each position once, and reconciles with the consolidation", async () => {
  const { consolidate } = await import("../src/engine/consolidate.ts");
  const ledger = ingest(true);
  const result = analyse(ledger)!;

  const consolidation = consolidate({
    ledger,
    assetClasses: readJson("params/shared/asset-classes.json"),
    fx: { rates: ledger.fx_rates, policy: fxPolicy },
    asof: "2026-06-30",
  });

  assert.ok(
    Math.abs(result.pfic.summary.investableWealthBase - consolidation.total.base.amount) < 0.05,
    `investable wealth ${result.pfic.summary.investableWealthBase} must reconcile with the consolidated total ${consolidation.total.base.amount}`
  );

  // Each (account, instrument) pair may appear at most once.
  const seen = new Set<string>();
  for (const holding of result.pfic.holdings as any[]) {
    const key = `${holding.accountToken}|${holding.instrumentName}`;
    assert.ok(!seen.has(key), `${key} counted more than once — historic snapshots are being double-counted`);
    seen.add(key);
  }

  // The ledger genuinely holds three snapshots per position, so this is a real
  // test rather than a vacuous one.
  const atlasSnapshots = ledger.holdings.filter(
    (h) => h.instrument_id === ledger.instruments.find((i) => i.identifiers.isin === "IE00SYNTH021")!.id
  );
  assert.ok(atlasSnapshots.length > 6, `expected multiple snapshots per position, found ${atlasSnapshots.length}`);
});

test("every metadata confirmation is written to the acceptance log", () => {
  const ledger = ingest(true);
  const confirmations = ledger.acceptances
    .flatMap((a) => a.lines)
    .filter((l) => l.note === "operator confirmed instrument metadata");
  assert.ok(confirmations.length > 0, "confirmations are decisions and must be auditable like any other");
  for (const line of confirmations) {
    assert.equal(line.kind, "holding");
    assert.ok(line.instrument_id, "the confirmation must name the instrument it applies to");
  }
});
