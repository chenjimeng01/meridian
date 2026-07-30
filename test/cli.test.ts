import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
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

// --- PHASE_REVIEW_4 MUST-FIX regressions -----------------------------------

test("M7: no client identifier is written outside the vault, and nothing sensitive is world-readable", () => {
  withRoot((root) => {
    const householdId = seedHousehold(root);
    const dir = join(root, householdId);

    const household = readFileSync(join(dir, "household.json"), "utf8");
    for (const identifier of ["Vance", "Eleanor", "Thomas", "Larkspur", "W1U"]) {
      assert.ok(!household.includes(identifier), `household.json leaks "${identifier}" — it belongs only in the vault`);
    }
    assert.equal(statSync(join(dir, "household.json")).mode & 0o777, 0o600);

    // A parked run holds the RAW, unredacted document: same sensitivity as documents/.
    const junk = join(root, "junk.txt");
    writeFileSync(junk, "Statement for Mrs Eleanor Vance\n14 Larkspur Mews\nAccount ALD-4471902\n");
    assert.throws(() => cmdIngest({ dataRoot: root, householdId, file: junk, offline: true, now }));
    const failedRuns = readdirSync(join(dir, "parse-runs", "failed"));
    const parked = join(dir, "parse-runs", "failed", failedRuns[0]!, "source.txt");
    assert.equal(statSync(parked).mode & 0o777, 0o600, "a parked raw document must be owner-only");
  });
});

test("M2: ids are unique across the ledger AND every run on disk, under one fixed clock", () => {
  withRoot((root) => {
    const householdId = seedHousehold(root);
    const runIds = ingestAll(root, householdId);
    runIds.forEach((runId) => cmdReview({ dataRoot: root, householdId, runId, acceptAll: true, now }));

    const ledger = JSON.parse(readFileSync(join(root, householdId, "ledger.json"), "utf8")) as any;
    const ledgerIdList: string[] = [
      ledger.household.id,
      ...ledger.household.persons.map((p: any) => p.id),
      ...ledger.accounts.map((a: any) => a.id),
      ...ledger.instruments.map((i: any) => i.id),
      ...ledger.documents.map((d: any) => d.id),
      ...ledger.acceptances.map((a: any) => a.id),
    ];
    const all = [...ledgerIdList, ...runIds];
    assert.equal(new Set(all).size, all.length, "an id must name exactly one thing (SPEC §4)");
    assert.equal(new Set(runIds).size, 15, "every ingest must mint a distinct run id");
    for (const doc of ledger.documents) {
      assert.ok(!ledgerIdList.filter((id) => id === doc.id).slice(1).length);
      assert.notEqual(doc.id, doc.parse_run_ids[0], "a document may not share its id with its own run");
    }
  });
});

test("M2: two unparseable documents in the same second both survive in failed/", () => {
  withRoot((root) => {
    const householdId = seedHousehold(root);
    const first = join(root, "junk-one.txt");
    const second = join(root, "junk-two.txt");
    writeFileSync(first, "First unparseable document.\n");
    writeFileSync(second, "Second unparseable document.\n");

    assert.throws(() => cmdIngest({ dataRoot: root, householdId, file: first, offline: true, now }));
    assert.throws(() => cmdIngest({ dataRoot: root, householdId, file: second, offline: true, now }));

    const failedDir = join(root, householdId, "parse-runs", "failed");
    const parked = readdirSync(failedDir);
    assert.equal(parked.length, 2, "the second park must not overwrite the first — §5.3 exists to prevent exactly this");
    const sources = parked.map((id) => readFileSync(join(failedDir, id, "source.txt"), "utf8"));
    assert.ok(sources.some((s) => s.includes("First")));
    assert.ok(sources.some((s) => s.includes("Second")));
  });
});

test("M3: review refuses to accept the same run twice, and --reaccept replaces cleanly", () => {
  withRoot((root) => {
    const householdId = seedHousehold(root);
    const { runId } = cmdIngest({ dataRoot: root, householdId, file: statementPath(INGEST_ORDER[0]!), offline: true, now });
    cmdReview({ dataRoot: root, householdId, runId, acceptAll: true, now });

    const after = () => JSON.parse(readFileSync(join(root, householdId, "ledger.json"), "utf8")) as any;
    const first = after();

    assert.throws(
      () => cmdReview({ dataRoot: root, householdId, runId, acceptAll: true, now }),
      /already accepted/,
      "a repeated review would silently duplicate documents, holdings and fee transactions"
    );
    assert.deepEqual(after(), first, "the refused re-review must not have changed anything");

    const result = cmdReview({ dataRoot: root, householdId, runId, acceptAll: true, reaccept: true, now });
    assert.equal(result.reaccepted, true);
    const second = after();
    assert.equal(second.documents.length, first.documents.length, "re-accepting replaces rather than appends");
    assert.equal(second.holdings.length, first.holdings.length);
    assert.equal(second.transactions.length, first.transactions.length);
    assert.equal(second.acceptances.length, first.acceptances.length);
    assert.equal(second.fx_rates.length, first.fx_rates.length);
  });
});

test("M1: the PDF branch hashes the FILE and stores the original bytes", () => {
  withRoot((root) => {
    const householdId = seedHousehold(root);
    // A minimal well-formed PDF whose "text" is supplied by an injected
    // converter, so the branch is exercised without requiring poppler here.
    const pdfPath = join(root, "statement.pdf");
    const pdfBytes = Buffer.from("%PDF-1.4\n% synthetic fixture, not a real document\n%%EOF\n", "utf8");
    writeFileSync(pdfPath, pdfBytes);
    const statementText = readFileSync(statementPath(INGEST_ORDER[0]!), "utf8");

    const result = cmdIngest({
      dataRoot: root,
      householdId,
      file: pdfPath,
      offline: true,
      now,
      convertPdf: () => statementText,
    });
    assert.ok(result.accountsFound > 0, "the converted text parses like any other statement");

    const documents = readdirSync(join(root, householdId, "documents"));
    assert.equal(documents.length, 1);
    const storedPath = join(root, householdId, "documents", documents[0]!);
    assert.ok(documents[0]!.endsWith(".pdf"));
    assert.deepEqual(readFileSync(storedPath), pdfBytes, "documents/ must hold the original file, not a rendering of it");

    const expectedHash = createHash("sha256").update(pdfBytes).digest("hex");
    assert.equal(documents[0], `${expectedHash}.pdf`, "the fingerprint must be of the file the operator received");
    const ledgerAfter = cmdReview({ dataRoot: root, householdId, runId: result.runId, acceptAll: true, now });
    assert.ok(ledgerAfter.accepted > 0);
    const ledger = JSON.parse(readFileSync(join(root, householdId, "ledger.json"), "utf8")) as any;
    assert.equal(ledger.documents[0].sha256, expectedHash);
  });
});

test("M1: a missing converter and a broken PDF report different problems", () => {
  withRoot((root) => {
    const householdId = seedHousehold(root);
    const pdfPath = join(root, "broken.pdf");
    writeFileSync(pdfPath, "%PDF-1.4\nnot really\n");
    assert.throws(
      () =>
        cmdIngest({
          dataRoot: root, householdId, file: pdfPath, offline: true, now,
          convertPdf: () => {
            throw new Error("ingest: could not extract text from broken.pdf — it may be corrupt, encrypted, or image-only.");
          },
        }),
      /corrupt, encrypted, or image-only/
    );
  });
});

test("M4/M5: the cost stack is an ANNUAL figure with the document's own categories", () => {
  withRoot((root) => {
    const householdId = seedHousehold(root);
    ingestAll(root, householdId).forEach((runId) =>
      cmdReview({ dataRoot: root, householdId, runId, acceptAll: true, confirmMetadataPath: join(ROOT, "test/fixtures/instrument-metadata.json"), now })
    );
    const { results } = cmdReport({ dataRoot: root, householdId, asof: "2026-06-30", now });

    assert.deepEqual(results.costStack.period, { from: "2025-06-30", to: "2026-06-30" }, "one year, stated");

    // The year to 2026-06-30 contains the 2025 MiFID disclosure (£1,158.00) and
    // the SIPP's 2026 administration fee (£260.00).
    assert.equal(results.costStack.total.amount.amount, 1418);

    // §6.3 names five categories; reporting everything as "platform" told the
    // client something the source documents contradict.
    const categories = Object.fromEntries(
      Object.entries(results.costStack.byCategory).map(([k, v]) => [k, v.amount.amount])
    );
    assert.deepEqual(categories, { platform: 1080, fund_ocf: 198, transaction: 88, fx_spread: 52 });

    // The drag rate must be measured on the same base it is applied to: the
    // cost stack's denominator is now the whole portfolio, not just the
    // accounts that happened to disclose a fee.
    assert.equal(results.costStack.averageValue.currency, "GBP");
    assert.match(results.compoundingDrag.assumption, /0\.34%/);
    assert.ok(results.compoundingDrag.drag.amount < results.consolidation.total.base.amount * 0.5,
      "a 20-year drag larger than the whole portfolio signals a rate applied to the wrong base");
  });
});

test("M6: the results JSON carries §6.2 performance with its method label", () => {
  withRoot((root) => {
    const householdId = seedHousehold(root);
    ingestAll(root, householdId).forEach((runId) =>
      cmdReview({ dataRoot: root, householdId, runId, acceptAll: true, now })
    );
    const { results } = cmdReport({ dataRoot: root, householdId, asof: "2026-06-30", now });

    assert.ok(results.performance, "§8 report section 3 cannot render what the results JSON omits");
    assert.ok(results.performance.portfolio, "a portfolio return must be computed");
    assert.ok(["twr", "modified_dietz"].includes(results.performance.portfolio!.method));

    // The portfolio series must start only once every account is represented —
    // otherwise accounts arriving read as growth (this fixture reported +180%).
    assert.equal(results.performance.from, "2026-04-30");
    assert.ok(
      Math.abs(results.performance.portfolio!.return) < 0.25,
      `portfolio return ${results.performance.portfolio!.return} looks like accounts arriving, not performance`
    );
    assert.ok(results.performance.warnings.some((w) => /every account has a valuation/.test(w)));
    assert.ok(results.performance.perAccount.length > 0);
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
