import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, readJson } from "./helpers.ts";
import { createVault, redactStatement } from "../src/ingest/redact.ts";
import { matchInstruments } from "../src/ingest/match.ts";
import { initHousehold, acceptRun, serializeLedger } from "../src/ingest/accept.ts";
import type { AcceptOptions, LineRef } from "../src/ingest/types.ts";
import { executeParseRun } from "../src/ingest/run.ts";
import { renderReviewHtml } from "../src/ingest/review-html.ts";
import { sequentialIds } from "../src/ingest/ids.ts";
import { INGEST_ORDER } from "../src/ingest/order.ts";

const config = readJson("test/fixtures/household-config.json") as any;

// Must match scripts/gen-golden-ingest.mts for the golden comparison to hold.
const PARSED_AT = "2026-07-30T11:00:00Z";
const ACCEPTED_AT = "2026-07-30T12:00:00Z";
const OPERATOR = "JC";

function runFullPipeline(decide?: AcceptOptions["decide"]) {
  const ids = sequentialIds();
  const vault = createVault(config, "fixture-salt");
  const ledger = initHousehold(config, ids);
  const runs = [];
  for (const rel of INGEST_ORDER) {
    const raw = readFileSync(join(ROOT, "test/fixtures/statements", rel), "utf8");
    const run = executeParseRun({ rawText: raw, filename: rel, ledger, vault, ids, createdAt: PARSED_AT });
    acceptRun(ledger, run, config, ids, {
      acceptedAt: ACCEPTED_AT,
      operatorInitials: OPERATOR,
      ...(decide ? { decide } : {}),
    });
    runs.push(run);
  }
  return { ledger, runs, vault };
}

test("full accept flow reproduces the golden ingested ledger byte-for-byte", () => {
  const { ledger } = runFullPipeline();
  const actual = serializeLedger(ledger);
  const golden = readFileSync(join(ROOT, "test/golden/ingested-ledger.json"), "utf8");
  assert.equal(actual, golden, "ingested ledger differs from golden — investigate before touching the golden");
});

test("ingested ledger is semantically equivalent to the Phase 1 fixture ledger", () => {
  const { ledger } = runFullPipeline();
  const fixture = readJson("test/fixtures/ledger/household-usuk.json") as any;

  const totals = (l: any) => {
    const byToken: Record<string, Record<string, number>> = {};
    for (const a of l.accounts) {
      const latest = l.holdings.filter((h: any) => h.account_id === a.id && h.asof === a.data_asof);
      const sums: Record<string, number> = {};
      for (const h of latest) sums[h.value.currency] = Math.round(((sums[h.value.currency] ?? 0) + h.value.amount) * 100) / 100;
      sums["__asof"] = a.data_asof; // data_asof must also agree per token
      byToken[a.account_token] = sums;
    }
    return byToken;
  };
  assert.deepEqual(totals(ledger), totals(fixture));

  // fx observations from the statements made it into the ledger
  assert.deepEqual(
    ledger.fx_rates.map((r: any) => [r.date, r.pair, r.rate]),
    fixture.fx_rates.map((r: any) => [r.date, r.pair, r.rate])
  );
});

test("ingested ledger validates against the ledger schema", async () => {
  const { Ajv2020 } = await import("ajv/dist/2020.js");
  const ajv = new Ajv2020({ strict: true, strictRequired: false });
  const validate = ajv.compile(readJson("schema/ledger.schema.json") as object);
  const { ledger } = runFullPipeline();
  assert.ok(validate(JSON.parse(serializeLedger(ledger))), JSON.stringify(validate.errors, null, 2));
});

test("deterministic identifier matching links repeat holdings to one instrument; fuzzy only proposes", () => {
  const { ledger } = runFullPipeline();
  // Atlas ETF appears in A2, A1 and A3 across 9 documents — must be ONE instrument.
  const atlas = ledger.instruments.filter((i: any) => i.identifiers.isin === "IE00SYNTH021");
  assert.equal(atlas.length, 1);
  assert.ok(atlas[0]!.prices.length >= 3, "statement price points accumulate on the one instrument");

  // Fuzzy: same name, no identifiers → candidate proposal, never an auto-link.
  const probe = {
    schema_version: "0.1",
    source: { institution: "X", doc_type: "valuation", period: { from: "2026-01-01", to: "2026-03-31" }, statement_currency: "GBP" },
    accounts: [{
      account_token: "A1", confidence: 0.9,
      holdings: [{ name: "Atlas Global Equity UCITS", identifiers: {}, units: 1, value: { amount: 65, currency: "GBP" }, confidence: 0.9 }],
    }],
    overall_confidence: 0.9,
  };
  const matches = matchInstruments(probe as any, ledger);
  assert.equal(matches[0]!.status, "candidates");
  assert.ok(matches[0]!.candidates!.includes(atlas[0]!.id));

  // Unknown name, no identifiers → new draft, flagged for review.
  (probe.accounts[0]!.holdings[0] as any).name = "Zephyr Frontier Momentum Sleeve";
  const matches2 = matchInstruments(probe as any, ledger);
  assert.equal(matches2[0]!.status, "new");
});

test("needs_review flags only instruments that could not be resolved by identifier (§5.4)", () => {
  const { ledger } = runFullPipeline();
  // Every fixture instrument carries an ISIN, so a clean run must flag none —
  // the flag has to carry signal, not be set on everything.
  assert.deepEqual(
    ledger.instruments.filter((i: any) => i.needs_review).map((i: any) => i.name),
    []
  );
});

test("every document is recorded with the raw file's sha256 and the run id", () => {
  const { ledger, runs } = runFullPipeline();
  assert.equal(ledger.documents.length, 15);
  for (let i = 0; i < INGEST_ORDER.length; i++) {
    const doc = ledger.documents[i]!;
    assert.equal(doc.filename, INGEST_ORDER[i]);
    const fixtureDoc = (readJson("test/fixtures/ledger/household-usuk.json") as any).documents
      .find((d: any) => d.filename === doc.filename);
    assert.equal(doc.sha256, fixtureDoc.sha256, `${doc.filename}: sha256 must be of the RAW statement`);
    assert.deepEqual(doc.parse_run_ids, [runs[i]!.id]);
  }
});

test("review HTML is mobile-first, confidence-annotated, and leaks no PII", () => {
  const ids = sequentialIds();
  const vault = createVault(config, "fixture-salt");
  const ledger = initHousehold(config, ids);
  // Warm the vault in canonical order so the Harcourt portfolio carries its
  // stable production token (A5) rather than a fresh-vault A1.
  for (const rel of INGEST_ORDER.slice(0, 9)) {
    redactStatement(readFileSync(join(ROOT, "test/fixtures/statements", rel), "utf8"), vault);
  }
  const raw = readFileSync(join(ROOT, "test/fixtures/statements/harcourt-private-bank/consolidated-2025-12.txt"), "utf8");
  const run = executeParseRun({ rawText: raw, filename: "harcourt-private-bank/consolidated-2025-12.txt", ledger, vault, ids, createdAt: PARSED_AT });
  const html = renderReviewHtml(run, ledger);

  assert.ok(html.includes("width=device-width"), "viewport meta required (mobile-first)");
  assert.ok(html.includes("A5"), "stable account token shown");
  assert.ok(html.includes("Pioneer S&amp;P Index Fund"), "holding names shown (HTML-escaped)");
  assert.ok(/0\.9[0-9]?/.test(html), "per-figure confidence shown");
  assert.ok(!/VANCE/i.test(html) && !html.includes("HPB-0055271"), "review file must be redacted");
  assert.ok(html.includes("new"), "proposed new entries are labelled against the current ledger");
  assert.ok(Buffer.byteLength(html) < 200 * 1024, "single-file review must stay lightweight");
});

// --- M1: per-line accept/edit/reject, and the timestamped acceptance log ----

test("rejected lines do not enter the ledger, and every decision is logged with a timestamp (§5.6)", () => {
  const rejectAtlas = (line: LineRef) =>
    line.kind === "holding" && line.ref.startsWith("Atlas")
      ? ({ action: "reject", note: "units disputed — awaiting contract note" } as const)
      : ({ action: "accept" } as const);

  const { ledger } = runFullPipeline(rejectAtlas);
  const atlas = ledger.instruments.find((i: any) => i.identifiers.isin === "IE00SYNTH021") as any;
  assert.equal(atlas, undefined, "a rejected holding must not create its instrument");
  assert.equal(
    ledger.holdings.filter((h: any) => h.name?.startsWith?.("Atlas")).length,
    0,
    "no rejected holding may enter the ledger"
  );

  assert.equal(ledger.acceptances.length, 15, "one acceptance record per accepted document");
  for (const record of ledger.acceptances) {
    assert.equal(record.accepted_at, ACCEPTED_AT);
    assert.equal(record.operator_initials, OPERATOR);
    assert.ok(record.lines.length > 0);
  }
  const rejected = ledger.acceptances.flatMap((r: any) => r.lines).filter((l: any) => l.action === "rejected");
  assert.ok(rejected.length >= 5, `expected the Atlas lines logged as rejected, got ${rejected.length}`);
  assert.equal(rejected[0].note, "units disputed — awaiting contract note");
});

test("edited lines enter the ledger with the operator's figures and log as edited", () => {
  const editThames = (line: LineRef) =>
    line.kind === "holding" && line.ref.startsWith("Thames")
      ? ({ action: "accept", edits: { units: 1750, value: { amount: 11042.5, currency: "GBP" } } } as const)
      : ({ action: "accept" } as const);

  const { ledger } = runFullPipeline(editThames);
  const thames = ledger.instruments.find((i: any) => i.identifiers.isin === "GB00SYNTH052")!;
  const entries = ledger.holdings.filter((h: any) => h.instrument_id === thames.id);
  assert.ok(entries.length > 0);
  for (const h of entries) {
    assert.equal(h.units, 1750, "operator's corrected units must win over the extracted value");
    assert.equal(h.value.amount, 11042.5);
  }
  const edited = ledger.acceptances.flatMap((r: any) => r.lines).filter((l: any) => l.action === "edited");
  assert.ok(edited.length >= 3, "edits are logged distinctly from plain acceptances");
});

test("documents carry the parse date and acceptance date the §8 appendix renders", () => {
  const { ledger } = runFullPipeline();
  for (const doc of ledger.documents) {
    assert.equal(doc.parsed_at, PARSED_AT);
    assert.equal(doc.accepted_at, ACCEPTED_AT);
  }
});

// --- M2: a confirmed fuzzy candidate must merge, not duplicate (§5.4) -------

test("confirming a fuzzy candidate through the accept path merges into that instrument", () => {
  const ids = sequentialIds();
  const vault = createVault(config, "fixture-salt");
  const ledger = initHousehold(config, ids);

  // Establish the Atlas ETF from a normal statement first.
  const first = "alderbrook-platform/valuation-2025-12.txt";
  const firstRun = executeParseRun({
    rawText: readFileSync(join(ROOT, "test/fixtures/statements", first), "utf8"),
    filename: first, ledger, vault, ids, createdAt: PARSED_AT,
  });
  acceptRun(ledger, firstRun, config, ids, { acceptedAt: ACCEPTED_AT, operatorInitials: OPERATOR });
  const atlas = ledger.instruments.find((i: any) => i.identifiers.isin === "IE00SYNTH021")!;
  const instrumentCountBefore = ledger.instruments.length;

  // A second document lists the same fund by a slightly different name with no
  // identifier — matchInstruments can only propose it.
  const probeRun = {
    id: "RUN-PROBE",
    filename: "probe.txt",
    sha256: "0".repeat(64),
    created_at: PARSED_AT,
    redactedText: "",
    output: {
      schema_version: "0.1",
      source: { institution: "Alderbrook Platform", doc_type: "valuation", period: { from: "2026-07-01", to: "2026-09-30" }, statement_currency: "GBP" },
      accounts: [{
        account_token: "A1", wrapper_hint: "gia", currency: "GBP", confidence: 0.9,
        holdings: [{ name: "Atlas Global Equity UCITS", identifiers: {}, units: 500, value: { amount: 32000, currency: "GBP" }, confidence: 0.72 }],
      }],
      overall_confidence: 0.72,
    },
    matches: [{ accountIndex: 0, holdingIndex: 0, status: "candidates" as const, candidates: [atlas.id] }],
  };

  acceptRun(ledger, probeRun as any, config, ids, {
    acceptedAt: ACCEPTED_AT,
    operatorInitials: OPERATOR,
    decide: (line) =>
      line.kind === "holding" && line.match?.status === "candidates"
        ? { action: "accept", instrumentId: line.match.candidates![0]!, note: "operator confirmed fuzzy match" }
        : { action: "accept" },
  });

  assert.equal(ledger.instruments.length, instrumentCountBefore, "a confirmed match must not create a duplicate instrument");
  const merged = ledger.holdings.filter((h: any) => h.instrument_id === atlas.id && h.asof === "2026-09-30");
  assert.equal(merged.length, 1, "the holding attaches to the confirmed instrument");
  const logLine = ledger.acceptances.at(-1)!.lines.find((l: any) => l.kind === "holding")!;
  assert.equal(logLine.instrument_id, atlas.id, "the confirmation is recorded in the acceptance log");
  assert.equal(logLine.note, "operator confirmed fuzzy match");
});

test("an unconfirmed identifier-less holding creates a draft flagged needs_review", () => {
  const ids = sequentialIds();
  const ledger = initHousehold(config, ids);
  const run = {
    id: "RUN-DRAFT", filename: "probe.txt", sha256: "0".repeat(64), created_at: PARSED_AT, redactedText: "",
    output: {
      schema_version: "0.1",
      source: { institution: "Alderbrook Platform", doc_type: "valuation", period: { from: "2026-07-01", to: "2026-09-30" }, statement_currency: "GBP" },
      accounts: [{
        account_token: "A1", wrapper_hint: "gia", currency: "GBP", confidence: 0.8,
        holdings: [{ name: "Zephyr Frontier Momentum Sleeve", identifiers: {}, units: 10, value: { amount: 500, currency: "GBP" }, confidence: 0.55 }],
      }],
      overall_confidence: 0.55,
    },
    matches: [{ accountIndex: 0, holdingIndex: 0, status: "new" as const }],
  };
  acceptRun(ledger, run as any, config, ids, { acceptedAt: ACCEPTED_AT, operatorInitials: OPERATOR });
  const draft = ledger.instruments.find((i: any) => i.name === "Zephyr Frontier Momentum Sleeve")!;
  assert.equal(draft.needs_review, true, "an unresolvable instrument must be flagged for operator review");
});

test("fixture ingest path makes no network calls and leaves NETWORK_AUDIT untouched", () => {
  const before = readFileSync(join(ROOT, "NETWORK_AUDIT.md"), "utf8");
  runFullPipeline();
  const after = readFileSync(join(ROOT, "NETWORK_AUDIT.md"), "utf8");
  assert.equal(after, before);
});
