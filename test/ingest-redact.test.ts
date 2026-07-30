import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROOT, readJson } from "./helpers.ts";
import {
  createVault,
  redactStatement,
  assertRedacted,
  findUnknownProperNouns,
  saveVault,
  loadVault,
  RedactionError,
} from "../src/ingest/redact.ts";
import { extractWithClaude } from "../src/ingest/extract-llm.ts";
import { INGEST_ORDER } from "../src/ingest/order.ts";

const config = readJson("test/fixtures/household-config.json") as any;
const statement = (rel: string) => readFileSync(join(ROOT, "test/fixtures/statements", rel), "utf8");

const FIXED_NOW = () => "2026-07-30T12:00:00Z";

test("redaction removes names, addresses and raw account numbers; tokens are stable across documents", () => {
  const vault = createVault(config, "fixture-salt");
  const first = redactStatement(statement("alderbrook-platform/valuation-2025-12.txt"), vault);

  assert.ok(!/VANCE/i.test(first), "client surname must not survive redaction");
  assert.ok(!first.includes("ALD-4471902"), "raw account number must not survive");
  assert.ok(!first.includes("Larkspur"), "street must not survive");
  assert.ok(!first.includes("W1U 0XX"), "postcode must not survive");
  assert.ok(first.includes("Account no: A1"), "GIA gets token A1 (first seen)");
  assert.ok(first.includes("Account no: A2"), "ISA gets token A2");

  // Same raw numbers in a later statement resolve to the same tokens.
  const second = redactStatement(statement("alderbrook-platform/valuation-2026-06.txt"), vault);
  assert.ok(second.includes("Account no: A1") && second.includes("Account no: A2"));
  assert.equal(vault.accounts["ALD-4471902"], "A1");

  // Names collapse to person tokens without leaking honorifics.
  assert.ok(first.includes("P1"), "person token appears");
  assert.ok(!/\bMS\s+P1\b/.test(first), "honorific must not survive next to a token");
});

test("all-caps name variant without honorific is still redacted (US brokerage layout)", () => {
  const vault = createVault(config, "fixture-salt");
  const red = redactStatement(statement("liberty-street-securities/statement-2026-04.txt"), vault);
  assert.ok(!/VANCE/i.test(red));
  assert.ok(!red.includes("774-20991"));
  assert.ok(!/LARKSPUR/i.test(red));
});

test("assertRedacted passes redacted text and throws on raw text", () => {
  const vault = createVault(config, "fixture-salt");
  const raw = statement("harcourt-private-bank/consolidated-2026-06.txt");
  const red = redactStatement(raw, vault);
  assertRedacted(red, vault); // must not throw
  assert.throws(() => assertRedacted(raw, vault), RedactionError);
  // Specimen numbers are assembled at runtime so the committed source itself
  // never contains a string the §9 pre-commit scanner would (rightly) block.
  const specimenNi = ["AB", "123456", "C"].join("");
  const specimenSsn = ["078", "05", "1120"].join("-");
  assert.throws(() => assertRedacted(`her NI is ${specimenNi}`, vault), RedactionError);
  assert.throws(() => assertRedacted(`ssn ${specimenSsn}`, vault), RedactionError);
});

test("SPEC §5 criterion (b): an unredacted payload can never reach the network", async () => {
  const vault = createVault(config, "fixture-salt");
  const raw = statement("alderbrook-platform/valuation-2025-12.txt");
  const calls: unknown[] = [];
  const audits: unknown[] = [];
  await assert.rejects(
    extractWithClaude(raw, {
      vault,
      apiKey: "test-key",
      fetchFn: (async (...args: unknown[]) => {
        calls.push(args);
        throw new Error("unreachable");
      }) as typeof fetch,
      appendAudit: (entry) => audits.push(entry),
      now: FIXED_NOW,
    }),
    RedactionError
  );
  assert.equal(calls.length, 0, "fetch must never be called with unredacted content");
  assert.equal(audits.length, 0, "no audit row for a blocked call");
});

test("SPEC §5 criterion (c): every API call is recorded in the network audit", async () => {
  const vault = createVault(config, "fixture-salt");
  const red = redactStatement(statement("sterling-park-wealth/mifid-costs-2025.txt"), vault);
  const expected = readJson("test/fixtures/expected/sterling-park-wealth/mifid-costs-2025.json");
  const audits: any[] = [];
  const fakeFetch = (async () =>
    new Response(
      JSON.stringify({ content: [{ type: "text", text: JSON.stringify(expected) }] }),
      { status: 200 }
    )) as typeof fetch;

  const out = await extractWithClaude(red, {
    vault,
    apiKey: "test-key",
    fetchFn: fakeFetch,
    appendAudit: (e) => audits.push(e),
    now: FIXED_NOW,
  });
  assert.deepEqual(out, expected);
  assert.equal(audits.length, 1);
  assert.equal(audits[0].endpoint, "https://api.anthropic.com/v1/messages");
  assert.equal(audits[0].redaction_check, "pass");
  assert.equal(audits[0].timestamp, "2026-07-30T12:00:00Z");
});

test("invalid extraction output triggers exactly one retry with validation errors, then parks", async () => {
  const vault = createVault(config, "fixture-salt");
  const red = redactStatement(statement("beacon-sipp-trustees/annual-2026.txt"), vault);
  const bodies: any[] = [];
  const audits: any[] = [];
  const fakeFetch = (async (_url: unknown, init: any) => {
    bodies.push(JSON.parse(init.body));
    return new Response(
      JSON.stringify({ content: [{ type: "text", text: JSON.stringify({ not: "valid" }) }] }),
      { status: 200 }
    );
  }) as typeof fetch;

  await assert.rejects(
    extractWithClaude(red, {
      vault,
      apiKey: "test-key",
      fetchFn: fakeFetch,
      appendAudit: (e) => audits.push(e),
      now: FIXED_NOW,
    }),
    /parked/i
  );
  assert.equal(bodies.length, 2, "one retry only");
  const retryText = JSON.stringify(bodies[1]);
  assert.ok(/schema_version|required/.test(retryText), "retry must carry the validation errors");
  assert.equal(audits.length, 2, "both calls audited");
});

// --- M3: a name the operator never listed must still block egress ---------

test("an unlisted personal name is detected and blocks the call (§5.2 NER pass)", async () => {
  const vault = createVault(config, "fixture-salt");
  // A third party the vault knows nothing about — an executor, adviser, joint
  // holder. Redaction cannot substitute it; the gate must refuse to transmit.
  const text = "Statement for P1\nJoint holder: Marguerite Ashdown\nTOTAL (GBP) £1,000.00";
  assert.throws(() => assertRedacted(text, vault), (err: unknown) => {
    assert.ok(err instanceof RedactionError);
    assert.match(err.message, /unrecognised proper noun "Marguerite Ashdown"/);
    return true;
  });

  const calls: unknown[] = [];
  await assert.rejects(
    extractWithClaude(text, {
      vault,
      apiKey: "test-key",
      fetchFn: (async (...a: unknown[]) => {
        calls.push(a);
        throw new Error("unreachable");
      }) as typeof fetch,
      appendAudit: () => {},
      now: FIXED_NOW,
    }),
    RedactionError
  );
  assert.equal(calls.length, 0, "an unrecognised name must never reach the network");
});

test("legitimate institution and instrument vocabulary does not trip the detector", () => {
  const vault = createVault(config, "fixture-salt");
  // Every redacted fixture statement must pass cleanly, or the gate is unusable.
  for (const rel of INGEST_ORDER) {
    const red = redactStatement(statement(rel), vault);
    assert.deepEqual(findUnknownProperNouns(red), [], `${rel}: false positive`);
  }
});

test("the detector's known limitation is a bare single-token surname", () => {
  // Documented in PROGRESS.md and params/shared/redaction-vocabulary.json:
  // single capitalised tokens are pervasive in statement layouts, so a lone
  // surname is NOT detected. This test pins the limitation so it cannot be
  // silently assumed away.
  assert.deepEqual(findUnknownProperNouns("Ashdown"), []);
  assert.deepEqual(findUnknownProperNouns("Dr Ashdown"), ["Dr Ashdown"]);
});

test("vault writes are owner-only and reload identically (§5.2, §9)", () => {
  const dir = mkdtempSync(join(tmpdir(), "meridian-vault-"));
  try {
    const path = join(dir, "vault.local.json");
    const vault = createVault(config, "fixture-salt");
    redactStatement(statement("alderbrook-platform/valuation-2025-12.txt"), vault);

    writeFileSync(path, "{}", { mode: 0o644 }); // pre-existing loose permissions
    saveVault(path, vault);
    assert.equal(statSync(path).mode & 0o777, 0o600, "vault must be owner-read/write only");
    assert.deepEqual(loadVault(path), vault);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("offline mode refuses all egress", async () => {
  const vault = createVault(config, "fixture-salt");
  const red = redactStatement(statement("beacon-sipp-trustees/annual-2024.txt"), vault);
  const calls: unknown[] = [];
  await assert.rejects(
    extractWithClaude(red, {
      vault,
      apiKey: "test-key",
      offline: true,
      fetchFn: (async (...a: unknown[]) => {
        calls.push(a);
        throw new Error("unreachable");
      }) as typeof fetch,
      appendAudit: () => {},
      now: FIXED_NOW,
    }),
    /offline/i
  );
  assert.equal(calls.length, 0);
});
