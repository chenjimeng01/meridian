import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import { ROOT, readJson } from "./helpers.ts";

import { cmdHouseholds, cmdIngest, cmdReview, cmdReport } from "../src/cli/commands.ts";
import { INGEST_ORDER } from "../src/ingest/order.ts";

// SPEC §10 Phase 4 acceptance gate:
//   "end-to-end: pdf → accepted ledger → results JSON on fixture"
// Everything below runs against a throwaway data root; no network, no clock.

const ajv = new Ajv2020({ strict: true, strictRequired: false, allErrors: true });
const compiledLedger = ajv.compile(readJson("schema/ledger.schema.json") as object);
// Wrapped so the ajv type guard does not narrow our ledger variable to unknown.
const validateLedger = (data: unknown): boolean => compiledLedger(data) as boolean;
const ledgerErrors = () => JSON.stringify(compiledLedger.errors, null, 2);

const CLOCK = ["2026-07-30T11:00:00Z", "2026-07-30T12:00:00Z"];
let tick = 0;
const now = () => CLOCK[Math.min(tick++, CLOCK.length - 1)]!;

function withRoot<T>(fn: (root: string) => T): T {
  const root = mkdtempSync(join(tmpdir(), "meridian-cli-"));
  try {
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const statementPath = (rel: string) => join(ROOT, "test/fixtures/statements", rel);

function seedHousehold(root: string) {
  tick = 0;
  const created = cmdHouseholds({
    dataRoot: root,
    action: "create",
    configPath: join(ROOT, "test/fixtures/household-config.json"),
    now,
  });
  return created.householdId;
}

function ingestAll(root: string, householdId: string) {
  const runs: string[] = [];
  for (const rel of INGEST_ORDER) {
    const result = cmdIngest({ dataRoot: root, householdId, file: statementPath(rel), offline: true, now });
    runs.push(result.runId);
  }
  return runs;
}

test("households create lays out the §3 directory structure and an owner-only vault", () => {
  withRoot((root) => {
    const householdId = seedHousehold(root);
    const dir = join(root, householdId);
    for (const sub of ["documents", "parse-runs", "reports"]) {
      assert.ok(existsSync(join(dir, sub)), `missing ${sub}/`);
    }
    assert.ok(existsSync(join(dir, "ledger.json")));
    const vault = join(dir, "vault.local.json");
    assert.ok(existsSync(vault));
    assert.equal(statSync(vault).mode & 0o777, 0o600, "the vault must be owner-only");

    const listed = cmdHouseholds({ dataRoot: root, action: "list", now });
    assert.deepEqual(listed.households.map((h) => h.id), [householdId]);
  });
});

test("ingest writes the raw document, a run record and a redacted review file (§5.5, §3)", () => {
  withRoot((root) => {
    const householdId = seedHousehold(root);
    const rel = INGEST_ORDER[0]!;
    const result = cmdIngest({ dataRoot: root, householdId, file: statementPath(rel), offline: true, now });

    const runDir = join(root, householdId, "parse-runs", result.runId);
    assert.ok(existsSync(join(runDir, "parse-output.json")), "the extracted output is kept for audit");
    assert.ok(existsSync(join(runDir, "review.html")), "§5.5 requires the run to PRODUCE a review file");

    const review = readFileSync(join(runDir, "review.html"), "utf8");
    assert.ok(!/VANCE/i.test(review) && !review.includes("ALD-4471902"), "the review file must be redacted");

    const stored = readdirSync(join(root, householdId, "documents"));
    assert.equal(stored.length, 1, "the raw document is preserved alongside the parse");

    // Nothing may enter the ledger before the operator accepts.
    const ledger = JSON.parse(readFileSync(join(root, householdId, "ledger.json"), "utf8")) as any;
    assert.equal(ledger.holdings.length, 0);
    assert.equal(ledger.documents.length, 0);
  });
});

test("a parse that cannot be understood parks in parse-runs/failed/ (§5.3)", () => {
  withRoot((root) => {
    const householdId = seedHousehold(root);
    const junk = join(root, "not-a-statement.txt");
    writeFileSync(junk, "This document contains no account section at all.\n");

    assert.throws(() => cmdIngest({ dataRoot: root, householdId, file: junk, offline: true, now }), /park/i);
    const failedDir = join(root, householdId, "parse-runs", "failed");
    assert.ok(existsSync(failedDir), "failed runs must land where §5.3 says");
    assert.ok(readdirSync(failedDir).length >= 1);
  });
});

test("review accepts line by line and only accepted lines reach the ledger (§5.6)", () => {
  withRoot((root) => {
    const householdId = seedHousehold(root);
    const rel = INGEST_ORDER[0]!;
    const { runId } = cmdIngest({ dataRoot: root, householdId, file: statementPath(rel), offline: true, now });

    const decisions = {
      operator_initials: "JC",
      lines: [{ kind: "holding", ref: "Thames Utilities PLC Ordinary 25p", action: "reject", note: "sold before period end" }],
    };
    const decisionsPath = join(root, "decisions.json");
    writeFileSync(decisionsPath, JSON.stringify(decisions, null, 2));

    const result = cmdReview({ dataRoot: root, householdId, runId, decisionsPath, now });
    assert.equal(result.accepted > 0, true);
    assert.equal(result.rejected, 1);

    const ledger = JSON.parse(readFileSync(join(root, householdId, "ledger.json"), "utf8")) as any;
    assert.ok(validateLedger(ledger), ledgerErrors());
    assert.equal(
      ledger.instruments.some((i: any) => i.name.startsWith("Thames")),
      false,
      "a rejected line must not enter the ledger"
    );
    assert.equal(ledger.acceptances.length, 1);
    assert.equal(ledger.acceptances[0].operator_initials, "JC");
    assert.equal(ledger.acceptances[0].accepted_at, CLOCK[1]);
  });
});

test("END TO END: statements → accepted ledger → results JSON (§10 Phase 4 gate)", () => {
  withRoot((root) => {
    const householdId = seedHousehold(root);
    ingestAll(root, householdId).forEach((runId) =>
      cmdReview({
        dataRoot: root,
        householdId,
        runId,
        acceptAll: true,
        confirmMetadataPath: join(ROOT, "test/fixtures/instrument-metadata.json"),
        now,
      })
    );

    const ledger = JSON.parse(readFileSync(join(root, householdId, "ledger.json"), "utf8")) as any;
    assert.ok(validateLedger(ledger), ledgerErrors());
    assert.equal(ledger.documents.length, 15);
    assert.equal(ledger.acceptances.length, 15);

    const { resultsPath, results } = cmdReport({ dataRoot: root, householdId, asof: "2026-06-30", now });
    const usConnect = results.usConnect as any;
    assert.ok(existsSync(resultsPath), "results JSON is written under reports/");

    // Same figures the engine suites pin, now via the CLI end to end.
    assert.equal(results.consolidation.total.base.amount, 442559.54);
    assert.equal(results.consolidation.total.secondary!.amount, 566476.21);
    assert.equal(results.consolidation.total.base.currency, "GBP");

    // The US module ran because P1 is a US person, and it found real flags —
    // which is only possible because metadata confirmation happened at review.
    assert.ok(results.usConnect, "US-connected section must be present for this household");
    const pfic = [...new Set(usConnect.pfic.holdings.filter((h: any) => h.outcome === "pfic").map((h: any) => h.instrumentName))].sort() as string[];
    assert.deepEqual(pfic, ["Atlas Global Equity UCITS ETF", "Sterling Park UK Equity Income OEIC Acc"]);
    assert.ok(usConnect.criticalCount > 0);

    assert.equal(results.costStack.total.amount.currency, "GBP");
    assert.ok(results.risk.singleIssuerFlags.length > 0);

    // §8 section 6: every figure traceable to its source document and parse date.
    for (const doc of results.appendix.documents) {
      assert.ok(doc.filename && doc.sha256 && doc.parsed_at && doc.accepted_at);
    }
  });
});

test("a UK-only household produces no US-connected section at all (§7)", () => {
  withRoot((root) => {
    tick = 0;
    const configPath = join(root, "uk-config.json");
    const base = readJson("test/fixtures/household-config.json") as any;
    writeFileSync(
      configPath,
      JSON.stringify(
        { ...base, persons: [{ ...base.persons[1], token: "P1" }], account_owners: Object.fromEntries(Object.keys(base.account_owners).map((k) => [k, ["P1"]])) },
        null,
        2
      )
    );
    const { householdId } = cmdHouseholds({ dataRoot: root, action: "create", configPath, now });
    ingestAll(root, householdId).forEach((runId) =>
      cmdReview({ dataRoot: root, householdId, runId, acceptAll: true, now })
    );
    const { results } = cmdReport({ dataRoot: root, householdId, asof: "2026-06-30", now });
    assert.equal(results.usConnect, null, "absent, not an empty section");
  });
});

test("the fixture path makes no network calls and never touches NETWORK_AUDIT.md", () => {
  const before = readFileSync(join(ROOT, "NETWORK_AUDIT.md"), "utf8");
  withRoot((root) => {
    const householdId = seedHousehold(root);
    ingestAll(root, householdId).forEach((runId) => cmdReview({ dataRoot: root, householdId, runId, acceptAll: true, now }));
    cmdReport({ dataRoot: root, householdId, asof: "2026-06-30", now });
  });
  assert.equal(readFileSync(join(ROOT, "NETWORK_AUDIT.md"), "utf8"), before);
});

test("the binary is wired: `meridian households list` runs from the shell", () => {
  withRoot((root) => {
    const out = execFileSync(
      process.execPath,
      ["--import", "tsx", join(ROOT, "src/cli/main.ts"), "households", "list", "--data-root", root],
      { encoding: "utf8", cwd: ROOT }
    );
    assert.match(out, /no households/i, "an empty data root reports itself clearly");
  });
});

test("--offline is honoured and reported by the CLI", () => {
  withRoot((root) => {
    const householdId = seedHousehold(root);
    const result = cmdIngest({ dataRoot: root, householdId, file: statementPath(INGEST_ORDER[0]!), offline: true, now });
    assert.equal(result.usedNetwork, false);
    assert.match(result.extractor, /deterministic|offline/i);
  });
});
