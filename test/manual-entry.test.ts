import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROOT, readJson } from "./helpers.ts";
import { cmdHouseholds, cmdIngest, cmdReview, cmdReport } from "../src/cli/commands.ts";
import { cmdManual, manualTemplate } from "../src/cli/manual.ts";

// SPEC §5.3 parks a document the extractor cannot understand "for manual
// entry"; §9 says --offline "disables all egress (parsing then requires manual
// entry mode)". Without a route back in, a parked document is simply lost and
// offline mode is a dead end.

const CLOCK = ["2026-07-30T11:00:00Z", "2026-07-30T12:00:00Z"];
let tick = 0;
const now = () => CLOCK[Math.min(tick++, CLOCK.length - 1)]!;

function withParked<T>(fn: (ctx: { root: string; householdId: string; parkedRunId: string }) => T): T {
  const root = mkdtempSync(join(tmpdir(), "meridian-manual-"));
  try {
    tick = 0;
    const { householdId } = cmdHouseholds({
      dataRoot: root,
      action: "create",
      configPath: join(ROOT, "test/fixtures/household-config.json"),
      now,
    });
    // A statement in a layout the deterministic parser does not recognise.
    const odd = join(root, "unrecognised.txt");
    writeFileSync(
      odd,
      [
        "ALDERBROOK PLATFORM",
        "Period: 2026-04-01 to 2026-06-30",
        "Statement currency: GBP",
        "MS ELEANOR VANCE",
        "Portfolio ref ALD-4471902 -- holdings overleaf, see enclosed schedule",
        "",
      ].join("\n")
    );
    assert.throws(() => cmdIngest({ dataRoot: root, householdId, file: odd, offline: true, now }), /park/i);
    const parkedRunId = readdirSync(join(root, householdId, "parse-runs", "failed"))[0]!;
    return fn({ root, householdId, parkedRunId });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("a template is offered for the parked document, redacted, with nothing guessed", () => {
  withParked(({ root, householdId, parkedRunId }) => {
    const result = cmdManual({ dataRoot: root, householdId, runId: parkedRunId, now });
    assert.ok(result.template, "the operator gets something to fill in");
    assert.ok(existsSync(result.reviewPath));

    // Read from the document where it can be, blank where it cannot — a wrong
    // default that survives review is worse than an empty field that cannot.
    assert.equal(result.template!.source.period.from, "2026-04-01");
    assert.equal(result.template!.source.period.to, "2026-06-30");
    assert.equal(result.template!.source.statement_currency, "GBP");
    assert.equal(result.template!.source.institution, "", "the institution is not guessed");
    assert.deepEqual(result.template!.accounts[0]!.holdings, [], "no holdings are invented");

    const redacted = readFileSync(join(root, householdId, "parse-runs", "failed", parkedRunId, "redacted-source.txt"), "utf8");
    assert.ok(!/VANCE/i.test(redacted), "the working copy the operator reads must be redacted");
    assert.ok(!redacted.includes("ALD-4471902"));
    assert.ok(redacted.includes("A1"), "and the account token is stable with the rest of the household");
  });
});

test("a filled-in entry rejoins the ordinary review and accept flow (§5.3, §5.6)", () => {
  withParked(({ root, householdId, parkedRunId }) => {
    const filled = manualTemplate(readFileSync(join(ROOT, "test/fixtures/statements/alderbrook-platform/valuation-2026-06.txt"), "utf8"));
    filled.source.institution = "Alderbrook Platform";
    filled.accounts = [
      {
        account_token: "A1",
        wrapper_hint: "gia",
        currency: "GBP",
        confidence: 0.95,
        holdings: [
          {
            name: "Thames Utilities PLC Ordinary 25p",
            identifiers: { isin: "GB00SYNTH052" },
            units: 1800,
            value: { amount: 11358, currency: "GBP" },
            confidence: 0.95,
          },
        ],
      },
    ];
    const inputPath = join(root, "filled.json");
    writeFileSync(inputPath, JSON.stringify(filled, null, 2));

    const entered = cmdManual({ dataRoot: root, householdId, runId: parkedRunId, inputPath, operatorInitials: "JC", now });
    assert.ok(existsSync(entered.reviewPath), "manual entry still produces a review file to accept from");

    // Nothing has entered the ledger yet — manual entry is a different way to
    // produce the extraction, not a way to bypass acceptance.
    let ledger = JSON.parse(readFileSync(join(root, householdId, "ledger.json"), "utf8")) as any;
    assert.equal(ledger.holdings.length, 0);

    cmdReview({ dataRoot: root, householdId, runId: entered.runId, acceptAll: true, operatorInitials: "JC", now });
    ledger = JSON.parse(readFileSync(join(root, householdId, "ledger.json"), "utf8")) as any;
    assert.equal(ledger.holdings.length, 1);
    assert.equal(ledger.holdings[0].value.amount, 11358);

    // The figure is traceable to the ORIGINAL document's bytes, exactly as an
    // extracted one would be, and the acceptance names the operator.
    const document = ledger.documents[0];
    assert.equal(ledger.holdings[0].source_document_id, document.id);
    assert.match(document.filename, /manual entry/);
    assert.equal(ledger.acceptances[0].operator_initials, "JC");
  });
});

test("a manual entry that does not satisfy the schema is refused", () => {
  withParked(({ root, householdId, parkedRunId }) => {
    const inputPath = join(root, "bad.json");
    writeFileSync(inputPath, JSON.stringify({ schema_version: "0.1", accounts: [] }));
    assert.throws(
      () => cmdManual({ dataRoot: root, householdId, runId: parkedRunId, inputPath, now }),
      /not a valid parse output/
    );
  });
});

test("offline mode reaches a finished report through manual entry alone (§9)", () => {
  withParked(({ root, householdId, parkedRunId }) => {
    // Every ordinary statement, ingested offline...
    for (const rel of readdirSync(join(ROOT, "test/fixtures/statements"))) {
      for (const file of readdirSync(join(ROOT, "test/fixtures/statements", rel))) {
        cmdIngest({ dataRoot: root, householdId, file: join(ROOT, "test/fixtures/statements", rel, file), offline: true, now });
      }
    }
    // ...plus the parked one, entered by hand.
    const filled = manualTemplate("Period: 2026-04-01 to 2026-06-30\ncurrency: GBP\nA1");
    filled.source.institution = "Alderbrook Platform";
    filled.accounts[0]!.holdings = [
      { name: "Manually entered holding", identifiers: {}, units: 1, value: { amount: 500, currency: "GBP" }, confidence: 0.9 },
    ];
    const inputPath = join(root, "filled.json");
    writeFileSync(inputPath, JSON.stringify(filled, null, 2));
    cmdManual({ dataRoot: root, householdId, runId: parkedRunId, inputPath, operatorInitials: "JC", now });

    for (const runId of readdirSync(join(root, householdId, "parse-runs")).filter((name) => name !== "failed")) {
      cmdReview({ dataRoot: root, householdId, runId, acceptAll: true, now });
    }
    const { results } = cmdReport({ dataRoot: root, householdId, asof: "2026-06-30", now });
    assert.ok(results.consolidation.total.base.amount > 0, "offline is not a dead end");
    assert.ok(
      results.appendix.documents.some((document) => /manual entry/.test(document.filename)),
      "the manually-entered document appears in the appendix like any other"
    );
  });
});

test("--offline refuses narration rather than silently skipping it (§9)", () => {
  const root = mkdtempSync(join(tmpdir(), "meridian-offline-"));
  try {
    tick = 0;
    const { householdId } = cmdHouseholds({
      dataRoot: root, action: "create",
      configPath: join(ROOT, "test/fixtures/household-config.json"), now,
    });
    const output = execFileSync(
      process.execPath,
      ["--import", "tsx", join(ROOT, "src/cli/main.ts"), "report",
       "--household", householdId, "--asof", "2026-06-30", "--data-root", root,
       "--offline", "--narrate", "--api-key", "unused"],
      { encoding: "utf8", cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] }
    ).toString();
    assert.fail(`expected a refusal, got: ${output}`);
  } catch (error: any) {
    assert.match(String(error.stderr ?? error.message), /cannot run with --offline/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the template is deliberately incomplete, and the schema refuses it until filled", async () => {
  const { Ajv2020 } = await import("ajv/dist/2020.js");
  const ajv = new Ajv2020({ strict: true, strictRequired: false });
  const validate = ajv.compile(readJson("schema/parse-output.schema.json") as object);

  const template = manualTemplate("Period: 2026-01-01 to 2026-03-31\ncurrency: USD\nA3 A4");
  assert.equal(template.accounts.length, 2, "every account token in the document gets a section");

  // The institution is left blank rather than guessed, and `minLength: 1`
  // means an unfilled template cannot be submitted by accident — the schema
  // is doing the work of making the operator actually read the document.
  assert.equal(template.source.institution, "");
  assert.equal(validate(template), false, "an unfilled template must not pass validation");

  template.source.institution = "Alderbrook Platform";
  assert.ok(validate(template), JSON.stringify(validate.errors, null, 2));
});
