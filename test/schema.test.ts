import { test } from "node:test";
import assert from "node:assert/strict";
import { Ajv2020 } from "ajv/dist/2020.js";
import { readJson, listFiles } from "./helpers.ts";

// strictRequired is off because the source-or-manual anyOf branches in the
// ledger schema reference properties defined on the parent subschema, which
// strictRequired cannot see. All other strict-mode checks stay on.
const ajv = new Ajv2020({ strict: true, strictRequired: false, allErrors: true });
const ledgerSchema = readJson("schema/ledger.schema.json") as object;
const parseOutputSchema = readJson("schema/parse-output.schema.json") as object;

const validateLedger = ajv.compile(ledgerSchema);
const validateParseOutput = ajv.compile(parseOutputSchema);

const errs = (v: { errors?: unknown }) => JSON.stringify(v.errors, null, 2);

test("both schemas compile under ajv strict mode", () => {
  assert.ok(validateLedger);
  assert.ok(validateParseOutput);
});

test("every committed ledger fixture validates against the ledger schema", () => {
  // PHASE_REVIEW_3 S5: the Phase-3 households were outside this gate.
  const ledgers = listFiles("test/fixtures/ledger", ".json");
  assert.ok(ledgers.length >= 4, `expected all ledger fixtures, found ${ledgers.length}`);
  for (const file of ledgers) {
    assert.ok(validateLedger(readJson(file)), `${file}: ${errs(validateLedger)}`);
  }
  assert.ok(validateLedger(readJson("test/golden/ingested-ledger.json")), errs(validateLedger));
});

test("every expected parse output validates against parse-output schema", () => {
  const files = listFiles("test/fixtures/expected", ".json");
  assert.ok(files.length >= 15, `expected >= 15 files, found ${files.length}`);
  for (const f of files) {
    assert.ok(validateParseOutput(readJson(f)), `${f}: ${errs(validateParseOutput)}`);
  }
});

// --- negative cases: the schema must actually reject bad data -------------

function cloneLedger(): any {
  return structuredClone(readJson("test/fixtures/ledger/household-usuk.json"));
}

test("ledger schema rejects a holding with no source (SPEC §4 design rule)", () => {
  const bad = cloneLedger();
  delete bad.holdings[0].source_document_id;
  assert.equal(validateLedger(bad), false);
});

test("ledger schema accepts a manual holding only with operator initials", () => {
  const manual = cloneLedger();
  delete manual.holdings[0].source_document_id;
  manual.holdings[0].source = "manual";
  assert.equal(validateLedger(manual), false, "manual without initials must fail");
  manual.holdings[0].operator_initials = "JC";
  assert.ok(validateLedger(manual), errs(validateLedger));
});

test("ledger schema rejects a non-ISO-4217 currency", () => {
  const bad = cloneLedger();
  bad.household.base_currency = "Pounds";
  assert.equal(validateLedger(bad), false);
});

test("ledger schema rejects an unknown wrapper", () => {
  const bad = cloneLedger();
  bad.accounts[0].wrapper = "offshore_trust";
  assert.equal(validateLedger(bad), false);
});

test("ledger schema rejects a malformed ULID", () => {
  const bad = cloneLedger();
  bad.household.id = "not-a-ulid";
  assert.equal(validateLedger(bad), false);
});

test("ledger schema rejects a raw account number where a token is required", () => {
  const bad = cloneLedger();
  bad.accounts[0].account_token = "12345678";
  assert.equal(validateLedger(bad), false);
});

test("ledger schema rejects unknown top-level properties", () => {
  const bad = cloneLedger();
  bad.client_name = "should never be here";
  assert.equal(validateLedger(bad), false);
});

test("parse-output schema rejects confidence outside [0,1]", () => {
  const files = listFiles("test/fixtures/expected", ".json");
  const bad = structuredClone(readJson(files[0]!)) as any;
  bad.overall_confidence = 1.2;
  assert.equal(validateParseOutput(bad), false);
});

test("parse-output schema rejects a missing statement period", () => {
  const files = listFiles("test/fixtures/expected", ".json");
  const bad = structuredClone(readJson(files[0]!)) as any;
  delete bad.source.period;
  assert.equal(validateParseOutput(bad), false);
});
