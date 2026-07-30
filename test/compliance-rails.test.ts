import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROOT } from "./helpers.ts";
import { cmdHouseholds, cmdIngest, cmdReview, cmdReport, cmdDelete } from "../src/cli/commands.ts";
import { openStore } from "../src/cli/store.ts";
import { assertNoAdvice, assertNarrationSafe, redactResultsForNarration, NarrativeRejected } from "../src/report/narrative.ts";
import { INGEST_ORDER } from "../src/ingest/order.ts";
import type { Results } from "../src/cli/results.ts";

// Controls a compliance review asked for, each of which had either no
// implementation or no test. The pattern these reviews kept finding is a
// guarantee that is named and then implemented more narrowly, so every rail
// here is tested by making it FAIL when it should, not merely pass when things
// are fine.

const CLOCK = ["2026-07-30T11:00:00Z", "2026-07-30T12:00:00Z"];
let tick = 0;
const now = () => CLOCK[Math.min(tick++, CLOCK.length - 1)]!;

function withHousehold<T>(fn: (ctx: { root: string; householdId: string }) => T): T {
  const root = mkdtempSync(join(tmpdir(), "meridian-compliance-"));
  try {
    tick = 0;
    const { householdId } = cmdHouseholds({
      dataRoot: root,
      action: "create",
      configPath: join(ROOT, "test/fixtures/household-config.json"),
      now,
    });
    return fn({ root, householdId });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// --- COBS 9A.5: reconstruct what the client received ------------------------

test("a re-issued report never overwrites the one already issued (COBS 9A.5)", () => {
  withHousehold(({ root, householdId }) => {
    // All of them: the FX rate the report needs is printed on the Harcourt
    // statements, so a partial ingest cannot be valued.
    for (const rel of INGEST_ORDER) {
      const { runId } = cmdIngest({
        dataRoot: root, householdId,
        file: join(ROOT, "test/fixtures/statements", rel), offline: true, now,
      });
      cmdReview({ dataRoot: root, householdId, runId, acceptAll: true, now });
    }

    cmdReport({ dataRoot: root, householdId, asof: "2026-06-30", now, html: true });
    // Same date, different assumptions — this used to destroy the first one.
    cmdReport({
      dataRoot: root, householdId, asof: "2026-06-30", now, html: true,
      benchmarkWeights: { global_equity_gbp: 1 },
    });

    const store = openStore(root, householdId);
    const issued = store.listIssuedReports();
    assert.equal(issued.length, 2, "both issues must be logged");
    assert.notEqual(issued[0]!.sha256, issued[1]!.sha256, "guard: the documents genuinely differ");
    for (const record of issued) {
      assert.ok(existsSync(record.path), `the issued document ${record.sha256.slice(0, 8)} must still exist`);
      const onDisk = readFileSync(record.path, "utf8");
      assert.ok(onDisk.length > 1000);
    }
    // The identity of a report is its content, so it cannot be silently swapped.
    assert.ok(issued[0]!.path !== issued[1]!.path);
  });
});

// --- UK GDPR Art. 17 --------------------------------------------------------

test("delete erases everything, including the places a manual rm would miss", () => {
  const root = mkdtempSync(join(tmpdir(), "meridian-erase-"));
  try {
    tick = 0;
    const { householdId } = cmdHouseholds({
      dataRoot: root, action: "create",
      configPath: join(ROOT, "test/fixtures/household-config.json"), now,
    });
    for (const rel of INGEST_ORDER) {
      const { runId } = cmdIngest({
        dataRoot: root, householdId,
        file: join(ROOT, "test/fixtures/statements", rel), offline: true, now,
      });
      cmdReview({ dataRoot: root, householdId, runId, acceptAll: true, now });
    }
    cmdReport({ dataRoot: root, householdId, asof: "2026-06-30", now, html: true });

    // A document the parser cannot read leaves a RAW, unredacted original in
    // parse-runs/failed/ — the thing a naive erasure would leave behind.
    // Kept OUTSIDE the data root: erasure removes what the tool stored, not
    // the operator's own copy of the original document. That limitation is
    // real and belongs in the retention policy, not hidden by the test.
    const elsewhere = mkdtempSync(join(tmpdir(), "meridian-operator-"));
    const junk = join(elsewhere, "unreadable.txt");
    writeFileSync(junk, "Statement for Mrs Eleanor Vance, 14 Larkspur Mews\n");
    assert.throws(() => cmdIngest({ dataRoot: root, householdId, file: junk, offline: true, now }));

    const dir = join(root, householdId);
    assert.ok(existsSync(join(dir, "vault.local.json")));
    assert.ok(readdirSync(join(dir, "documents")).length > 0);
    assert.ok(readdirSync(join(dir, "parse-runs", "failed")).length > 0);

    // Erasure is never inferred.
    assert.throws(
      () => cmdDelete({ dataRoot: root, householdId, confirm: false, now }),
      /without --confirm/
    );
    assert.ok(existsSync(dir), "a refused deletion must change nothing");

    const result = cmdDelete({ dataRoot: root, householdId, confirm: true, now });
    assert.ok(result.removed.includes("vault.local.json"));
    assert.ok(result.removed.includes("documents"));
    assert.ok(result.removed.includes("parse-runs"));
    assert.equal(existsSync(dir), false, "nothing may survive erasure");

    // And nothing identifying is left anywhere under the data root.
    const remaining: string[] = [];
    const walk = (path: string) => {
      for (const entry of readdirSync(path, { withFileTypes: true })) {
        const child = join(path, entry.name);
        if (entry.isDirectory()) walk(child);
        else remaining.push(readFileSync(child, "utf8"));
      }
    };
    walk(root);
    for (const contents of remaining) {
      assert.equal(/Eleanor Vance|Larkspur/i.test(contents), false, "a client identifier survived erasure");
    }
    // The operator's own copy is untouched, by design — say so explicitly.
    assert.ok(existsSync(junk), "erasure does not reach files outside the data root");
    rmSync(elsewhere, { recursive: true, force: true });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// --- §9: nothing sensitive is world-readable --------------------------------

test("every file holding client data is owner-only", () => {
  withHousehold(({ root, householdId }) => {
    for (const rel of INGEST_ORDER) {
      const { runId } = cmdIngest({
        dataRoot: root, householdId,
        file: join(ROOT, "test/fixtures/statements", rel), offline: true, now,
      });
      cmdReview({ dataRoot: root, householdId, runId, acceptAll: true, now });
    }
    cmdReport({ dataRoot: root, householdId, asof: "2026-06-30", now, html: true });

    const dir = join(root, householdId);
    const check = (path: string) => {
      assert.equal(
        statSync(path).mode & 0o777,
        0o600,
        `${path.replace(dir, "")} is not owner-only — the vault's 600 is pointless beside a 644 ledger`
      );
    };
    check(join(dir, "vault.local.json"));
    check(join(dir, "household.json"));
    check(join(dir, "ledger.json"));
    for (const file of readdirSync(join(dir, "documents"))) check(join(dir, "documents", file));
    for (const file of readdirSync(join(dir, "reports")).filter((f) => f.endsWith(".html") || f.endsWith(".json"))) {
      check(join(dir, "reports", file));
    }
  });
});

// --- §9 egress and advice gates, which had no tests at all ------------------

test("assertNoAdvice refuses recommendation phrasing (§9 perimeter)", () => {
  for (const advisory of [
    "You should consider moving the ISA.",
    "We recommend switching to a US-registered fund.",
    "It would be sensible to sell before April.",
    "The best course is to unwind the offshore bond.",
  ]) {
    assert.throws(() => assertNoAdvice(advisory), NarrativeRejected, `not refused: "${advisory}"`);
  }
  // Description, not recommendation, must still pass.
  assert.doesNotThrow(() => assertNoAdvice("The ISA holds pooled funds that are US-taxable annually."));
});

test("narration strips the operator's own filenames before any egress (§5.2)", () => {
  const results = {
    meta: { schema_version: "0.1", generated_at: "2026-07-30T12:00:00Z", asof: "2026-06-30", household_id: "01X", base_currency: "GBP" },
    appendix: {
      documents: [
        {
          filename: "/Users/adviser/clients/Eleanor Vance Q2 statement.pdf",
          institution: "Alderbrook Platform",
          doc_type: "valuation",
          sha256: "a".repeat(64),
          period: { from: "2026-04-01", to: "2026-06-30" },
        },
      ],
      instrumentsNeedingConfirmation: [],
      accountFreshness: {},
    },
  } as unknown as Results;

  const payload = redactResultsForNarration(results);
  const serialised = JSON.stringify(payload);
  assert.equal(/Eleanor Vance/.test(serialised), false, "the client's name was in the FILENAME");
  assert.equal(/\/Users\/adviser/.test(serialised), false, "and so was the adviser's directory structure");
  assert.doesNotThrow(() => assertNarrationSafe(payload));

  // The gate must actually refuse, not merely exist.
  assert.throws(() => assertNarrationSafe(results), /refusing to transmit/);
  assert.throws(() => assertNarrationSafe(payload, ["Alderbrook"]), /refusing to transmit/);
});

test("the audit row identifies whose data went where (Art. 33)", async () => {
  const { fileAuditAppender } = await import("../src/ingest/audit.ts");
  const dir = mkdtempSync(join(tmpdir(), "meridian-audit-"));
  try {
    const path = join(dir, "NETWORK_AUDIT.md");
    writeFileSync(path, "");
    fileAuditAppender(path)({
      timestamp: "2026-03-03T09:00:00Z",
      endpoint: "https://api.anthropic.com/v1/messages",
      purpose: "extract",
      redaction_check: "pass",
      household_id: "01HOUSEHOLD",
      document_ref: "sha256:abcdef",
    });
    const row = readFileSync(path, "utf8");
    assert.match(row, /01HOUSEHOLD/, "you cannot answer 'whose data' without this");
    assert.match(row, /sha256:abcdef/);
    assert.match(row, /2026-03-03T09:00:00Z/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
