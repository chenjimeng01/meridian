// Manual entry for parked documents (SPEC §5.3, §9, Phase 6).
//
// A document the extractor cannot turn into schema-valid output is parked
// rather than dropped. Without a way back in, two things are broken: the
// parked document is simply lost, and `--offline` — which §9 says "disables
// all egress (parsing then requires manual entry mode)" — is a dead end for
// anything the deterministic parser does not recognise.
//
// The route back in is deliberately the SAME route: the operator fills in a
// parse-output document, it is schema-validated, and it then goes through the
// ordinary review and accept flow. Manual entry is a different way to produce
// the extraction, not a way to bypass acceptance.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import { assertSafeId, openStore } from "./store.ts";
import { ledgerIds } from "./ids.ts";
import { matchInstruments } from "../ingest/match.ts";
import { redactStatement } from "../ingest/redact.ts";
import { renderReviewHtml } from "../ingest/review-html.ts";
import type { ParseOutput, ParseRun } from "../ingest/types.ts";
import type { BaseOptions } from "./commands.ts";

// fileURLToPath, not URL.pathname: a repo path containing a space arrives
// percent-encoded otherwise.
const SCHEMA_PATH = join(dirname(fileURLToPath(import.meta.url)), "../../schema/parse-output.schema.json");
const ajv = new Ajv2020({ strict: true, strictRequired: false, allErrors: true });
const validateParseOutput = ajv.compile(JSON.parse(readFileSync(SCHEMA_PATH, "utf8")));

export interface ManualOptions extends BaseOptions {
  householdId: string;
  runId: string;
  /** A filled-in parse-output JSON. Omit to emit a skeleton to work from. */
  inputPath?: string;
  operatorInitials?: string;
}

/**
 * A skeleton for the operator to fill in, pre-filled with whatever can be read
 * from the parked document without guessing. Anything the system cannot know
 * is left blank rather than filled with a plausible default — a wrong default
 * that survives review is worse than an empty field that cannot.
 */
export function manualTemplate(redactedSource: string): ParseOutput {
  const period = redactedSource.match(/(\d{4}-\d{2}-\d{2})\s+to\s+(\d{4}-\d{2}-\d{2})/);
  const currency = redactedSource.match(/currency:\s*([A-Z]{3})/);
  const tokens = [...new Set(redactedSource.match(/\bA\d+\b/g) ?? [])];

  return {
    schema_version: "0.1",
    source: {
      institution: "",
      doc_type: "valuation",
      period: { from: period?.[1] ?? "", to: period?.[2] ?? "" },
      statement_currency: currency?.[1] ?? "GBP",
    },
    accounts: (tokens.length ? tokens : ["A1"]).map((token) => ({
      account_token: token,
      wrapper_hint: "unknown",
      // Manual entry is transcription by a human who is reading the document,
      // so the figures are as good as the document — but they are still a
      // transcription, and the score says so.
      confidence: 0.95,
      holdings: [],
    })),
    overall_confidence: 0.95,
    warnings: ["entered manually from a document the extractor could not parse"],
  };
}

export interface ManualResult {
  runId: string;
  reviewPath: string;
  template?: ParseOutput;
  accountsFound: number;
}

export function cmdManual(options: ManualOptions): ManualResult {
  assertSafeId(options.runId, "run id");
  const store = openStore(options.dataRoot, options.householdId);
  const parked = store.loadParkedRun(options.runId);
  const vault = store.loadVault();
  const redacted = redactStatement(parked.source, vault);
  store.saveVault(vault);

  if (!options.inputPath) {
    const template = manualTemplate(redacted);
    store.saveRun(join("failed", options.runId), {
      "manual-template.json": JSON.stringify(template, null, 2) + "\n",
      "redacted-source.txt": redacted,
    });
    return {
      runId: options.runId,
      reviewPath: join(store.runDir(join("failed", options.runId)), "manual-template.json"),
      template,
      accountsFound: template.accounts.length,
    };
  }

  const output = JSON.parse(readFileSync(options.inputPath, "utf8")) as ParseOutput;
  if (!validateParseOutput(output)) {
    throw new Error(
      `manual: ${options.inputPath} is not a valid parse output — ${JSON.stringify(validateParseOutput.errors)}`
    );
  }

  const ledger = store.loadLedger();
  const createdAt = options.now();
  const ids = ledgerIds(ledger, createdAt, store.listAllRunIds());
  // The fingerprint is of the original document, so a manually-entered figure
  // is traceable to exactly the same bytes an extracted one would be.
  const sha256 = createHash("sha256").update(parked.source).digest("hex");
  const documentPath = store.storeDocument(`${options.runId}.txt`, Buffer.from(parked.source, "utf8"), sha256);

  const run: ParseRun = {
    id: ids(),
    filename: `${options.runId} (manual entry)`,
    sha256,
    created_at: createdAt,
    redactedText: redacted,
    output,
    matches: matchInstruments(output, ledger),
  };
  const runDir = store.saveRun(run.id, {
    "run.json":
      JSON.stringify(
        {
          runId: run.id,
          filename: run.filename,
          sha256,
          createdAt,
          documentPath,
          manualEntry: true,
          parkedRunId: options.runId,
          operator: options.operatorInitials ?? "OP",
        },
        null,
        2
      ) + "\n",
    "parse-output.json": JSON.stringify(output, null, 2) + "\n",
    "review.html": renderReviewHtml(run, ledger),
  });

  return {
    runId: run.id,
    reviewPath: join(runDir, "review.html"),
    accountsFound: output.accounts.length,
  };
}
