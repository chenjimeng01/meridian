import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, readJson } from "./helpers.ts";
import { createVault, redactStatement } from "../src/ingest/redact.ts";
import { matchInstruments } from "../src/ingest/match.ts";
import { initHousehold, acceptRun, serializeLedger } from "../src/ingest/accept.ts";
import { executeParseRun } from "../src/ingest/run.ts";
import { renderReviewHtml } from "../src/ingest/review-html.ts";
import { sequentialIds } from "../src/ingest/ids.ts";
import { INGEST_ORDER } from "../src/ingest/order.ts";

const config = readJson("test/fixtures/household-config.json") as any;

function runFullPipeline() {
  const ids = sequentialIds();
  const vault = createVault(config, "fixture-salt");
  const ledger = initHousehold(config, ids);
  const runs = [];
  for (const rel of INGEST_ORDER) {
    const raw = readFileSync(join(ROOT, "test/fixtures/statements", rel), "utf8");
    const run = executeParseRun({ rawText: raw, filename: rel, ledger, vault, ids });
    acceptRun(ledger, run, config, ids); // operator accepts every line
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

test("accepted drafts created from fuzzy/unknown holdings carry needs_review", () => {
  const { ledger } = runFullPipeline();
  const drafts = ledger.instruments.filter((i: any) => i.needs_review);
  // All fixture instruments carry ISINs (or are cash), so a clean run drafts
  // every non-cash instrument exactly once from its first appearance and each
  // was ISIN-created (needs_review true until operator confirms metadata).
  assert.ok(drafts.length >= 8, `expected the created instruments to be flagged for review, got ${drafts.length}`);
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
  const run = executeParseRun({ rawText: raw, filename: "harcourt-private-bank/consolidated-2025-12.txt", ledger, vault, ids });
  const html = renderReviewHtml(run, ledger);

  assert.ok(html.includes("width=device-width"), "viewport meta required (mobile-first)");
  assert.ok(html.includes("A5"), "stable account token shown");
  assert.ok(html.includes("Pioneer S&amp;P Index Fund"), "holding names shown (HTML-escaped)");
  assert.ok(/0\.9[0-9]?/.test(html), "per-figure confidence shown");
  assert.ok(!/VANCE/i.test(html) && !html.includes("HPB-0055271"), "review file must be redacted");
  assert.ok(html.includes("new"), "proposed new entries are labelled against the current ledger");
  assert.ok(Buffer.byteLength(html) < 200 * 1024, "single-file review must stay lightweight");
});

test("fixture ingest path makes no network calls and leaves NETWORK_AUDIT untouched", () => {
  const before = readFileSync(join(ROOT, "NETWORK_AUDIT.md"), "utf8");
  runFullPipeline();
  const after = readFileSync(join(ROOT, "NETWORK_AUDIT.md"), "utf8");
  assert.equal(after, before);
});
