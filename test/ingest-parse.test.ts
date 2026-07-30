import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, readJson } from "./helpers.ts";
import { createVault, redactStatement } from "../src/ingest/redact.ts";
import { parseFixtureStatement, serializeParseOutput } from "../src/ingest/extract-fixture.ts";
import { INGEST_ORDER } from "../src/ingest/order.ts";

const config = readJson("test/fixtures/household-config.json") as any;

test("SPEC §5 criterion (a): all 15 fixtures parse to expected canonical output byte-for-byte", () => {
  // One vault across the whole sequence: account tokens must allocate in the
  // documented ingestion order for the byte-for-byte comparison to hold.
  const vault = createVault(config, "fixture-salt");
  assert.equal(INGEST_ORDER.length, 15);
  for (const rel of INGEST_ORDER) {
    const raw = readFileSync(join(ROOT, "test/fixtures/statements", rel), "utf8");
    const redacted = redactStatement(raw, vault);
    const output = parseFixtureStatement(redacted);
    const actual = serializeParseOutput(output);
    const expected = readFileSync(join(ROOT, "test/fixtures/expected", rel.replace(/\.txt$/, ".json")), "utf8");
    assert.equal(actual, expected, `${rel}: parser output differs from expected canonical output`);
  }
});

test("parser output covers every priority parser doc_type", () => {
  const vault = createVault(config, "fixture-salt");
  const types = new Set<string>();
  const institutions = new Set<string>();
  for (const rel of INGEST_ORDER) {
    const raw = readFileSync(join(ROOT, "test/fixtures/statements", rel), "utf8");
    const out = parseFixtureStatement(redactStatement(raw, vault));
    types.add(out.source.doc_type);
    institutions.add(out.source.institution);
  }
  assert.ok(types.has("valuation") && types.has("mifid_costs"));
  assert.equal(institutions.size, 5);
});
