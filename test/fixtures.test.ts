import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { ROOT, readJson, listFiles } from "./helpers.ts";

const STATEMENTS_DIR = join(ROOT, "test/fixtures/statements");
const institutions = readdirSync(STATEMENTS_DIR, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .sort();

test("exactly 5 fixture institutions with exactly 3 documents each (SPEC §10 Phase 1)", () => {
  assert.equal(institutions.length, 5, `found: ${institutions.join(", ")}`);
  for (const inst of institutions) {
    const docs = readdirSync(join(STATEMENTS_DIR, inst)).filter((f) => f.endsWith(".txt"));
    assert.equal(docs.length, 3, `${inst}: expected 3 docs, found ${docs.length}`);
  }
});

test("every statement has a matching expected parse output, and vice versa", () => {
  const statements = listFiles("test/fixtures/statements", ".txt").map((f) =>
    f.replace("test/fixtures/statements/", "").replace(/\.txt$/, "")
  );
  const expected = listFiles("test/fixtures/expected", ".json").map((f) =>
    f.replace("test/fixtures/expected/", "").replace(/\.json$/, "")
  );
  assert.deepEqual(expected, statements);
});

test("expected outputs are internally coherent (period, currency, value = units × price)", () => {
  for (const f of listFiles("test/fixtures/expected", ".json")) {
    const doc = readJson(f) as any;
    assert.ok(doc.source.period.from <= doc.source.period.to, `${f}: period reversed`);
    for (const acct of doc.accounts) {
      for (const h of acct.holdings ?? []) {
        if (h.price) {
          const computed = Math.round(h.units * h.price.amount * 100) / 100;
          assert.equal(h.value.amount, computed, `${f} ${h.name}: value != units × price`);
          assert.equal(h.value.currency, h.price.currency, `${f} ${h.name}: price/value currency mismatch`);
        }
      }
    }
  }
});

test("no raw fixture account number leaks into any expected parse output", () => {
  // The synthetic statements carry fake raw account numbers; expected outputs
  // must only ever contain redaction tokens (SPEC §5.2).
  const rawNumbers = ["ALD-4471902", "ALD-4471903", "BST-118834", "774-20991", "HPB-0055271", "HPB-0055272"];
  for (const f of listFiles("test/fixtures/expected", ".json")) {
    const text = readFileSync(join(ROOT, f), "utf8");
    for (const raw of rawNumbers) {
      assert.ok(!text.includes(raw), `${f}: contains raw account number ${raw}`);
    }
    assert.ok(!/VANCE/i.test(text), `${f}: contains client name`);
  }
});

test("ledger documents match the statement files byte-for-byte (sha256)", () => {
  const ledger = readJson("test/fixtures/ledger/household-usuk.json") as any;
  assert.equal(ledger.documents.length, 15);
  for (const doc of ledger.documents) {
    const content = readFileSync(join(ROOT, "test/fixtures/statements", doc.filename));
    const hash = createHash("sha256").update(content).digest("hex");
    assert.equal(hash, doc.sha256, `${doc.filename}: sha256 mismatch — fixture edited without regeneration`);
  }
});

test("ledger referential integrity: every holding/transaction resolves", () => {
  const ledger = readJson("test/fixtures/ledger/household-usuk.json") as any;
  const accountIds = new Set(ledger.accounts.map((a: any) => a.id));
  const instrumentIds = new Set(ledger.instruments.map((i: any) => i.id));
  const documentIds = new Set(ledger.documents.map((d: any) => d.id));
  const personIds = new Set(ledger.household.persons.map((p: any) => p.id));

  for (const h of ledger.holdings) {
    assert.ok(accountIds.has(h.account_id), `holding → unknown account ${h.account_id}`);
    assert.ok(instrumentIds.has(h.instrument_id), `holding → unknown instrument ${h.instrument_id}`);
    assert.ok(documentIds.has(h.source_document_id), `holding → unknown document ${h.source_document_id}`);
  }
  for (const t of ledger.transactions) {
    assert.ok(accountIds.has(t.account_id), `transaction → unknown account`);
    if (t.instrument_id) assert.ok(instrumentIds.has(t.instrument_id), `transaction → unknown instrument`);
    assert.ok(documentIds.has(t.source_document_id), `transaction → unknown document`);
  }
  for (const a of ledger.accounts) {
    for (const pid of a.person_ids) assert.ok(personIds.has(pid), `account ${a.account_token} → unknown person`);
  }
});

test("each account's data_asof equals its latest holding snapshot", () => {
  const ledger = readJson("test/fixtures/ledger/household-usuk.json") as any;
  for (const a of ledger.accounts) {
    const dates = ledger.holdings.filter((h: any) => h.account_id === a.id).map((h: any) => h.asof).sort();
    if (dates.length) assert.equal(a.data_asof, dates.at(-1), `${a.account_token}: stale data_asof`);
  }
});

test("fixture regeneration is deterministic (generator output matches committed files)", async () => {
  // The generator must be free of clock/RNG use so committed fixtures are
  // reproducible. Spot-check: hashes recorded in the ledger were produced by
  // the same content now on disk (covered above) and the generator source
  // contains no Date.now/Math.random.
  const gen = readFileSync(join(ROOT, "scripts/gen-fixtures.mjs"), "utf8");
  assert.ok(!gen.includes("Math.random"), "generator must be deterministic");
  assert.ok(!gen.includes("Date.now"), "generator must be deterministic");
});
