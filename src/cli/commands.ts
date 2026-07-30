// Operator commands (SPEC §5, §10 Phase 4): households / ingest / review /
// report. This layer owns the clock, the filesystem and any network egress;
// everything it calls is pure.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { createHousehold, listHouseholds, openStore, type HouseholdStore, type RunMeta } from "./store.ts";
import { ledgerIds } from "./ids.ts";
import { initHousehold, acceptRun, type HouseholdConfig } from "../ingest/accept.ts";
import { executeParseRun } from "../ingest/run.ts";
import { matchInstruments } from "../ingest/match.ts";
import { renderReviewHtml } from "../ingest/review-html.ts";
import { extractWithClaude } from "../ingest/extract-llm.ts";
import { fileAuditAppender } from "../ingest/audit.ts";
import { buildResults, type Results } from "./results.ts";
import type { Ledger, LineDecision, LineRef, MetadataConfirmation, ParseRun } from "../ingest/types.ts";

export interface BaseOptions {
  dataRoot: string;
  /** Injected clock — the only place a timestamp enters the system. */
  now: () => string;
}

// --- households -------------------------------------------------------------

export interface HouseholdsOptions extends BaseOptions {
  action: "create" | "list";
  configPath?: string;
  householdId?: string;
}

export function cmdHouseholds(options: HouseholdsOptions): {
  householdId: string;
  households: { id: string; persons: number; baseCurrency: string }[];
} {
  if (options.action === "list") {
    return {
      householdId: "",
      households: listHouseholds(options.dataRoot).map((h) => ({
        id: h.id,
        persons: h.config.persons.length,
        baseCurrency: h.config.base_currency,
      })),
    };
  }
  if (!options.configPath) throw new Error("households create: --config is required");
  const config = JSON.parse(readFileSync(options.configPath, "utf8")) as HouseholdConfig;
  const timestamp = options.now();
  const ids = ledgerIds(null, timestamp);
  const ledger = initHousehold(config, ids);
  const householdId = ledger.household.id;
  createHousehold(options.dataRoot, householdId, config, ledger, householdId);
  return { householdId, households: [] };
}

// --- ingest -----------------------------------------------------------------

export interface IngestOptions extends BaseOptions {
  householdId: string;
  file: string;
  offline?: boolean;
  apiKey?: string;
  auditPath?: string;
  /** Override the PDF→text converter (tests, or a different toolchain). */
  convertPdf?: PdfConverter;
}

export interface IngestResult {
  runId: string;
  reviewPath: string;
  usedNetwork: boolean;
  extractor: string;
  accountsFound: number;
}

/** Converts a PDF to text. Injectable so the branch is testable without poppler. */
export type PdfConverter = (file: string) => string;

const pdftotextConverter: PdfConverter = (file) => {
  try {
    execFileSync("pdftotext", ["-v"], { stdio: "ignore" });
  } catch {
    throw new Error(
      `ingest: ${basename(file)} is a PDF and 'pdftotext' is not installed. Install poppler-utils, or convert the document to text yourself and ingest that.`
    );
  }
  try {
    return execFileSync("pdftotext", ["-layout", "-enc", "UTF-8", file, "-"], { encoding: "utf8" });
  } catch (error) {
    // A corrupt, encrypted or password-protected PDF is a different problem
    // from a missing converter, and must not be reported as one.
    throw new Error(
      `ingest: could not extract text from ${basename(file)} — it may be corrupt, encrypted, or image-only. ${(error as Error).message}`
    );
  }
};

/**
 * §5 step 1: fingerprint the FILE, then read it as text.
 *
 * The hash must be of the bytes the operator received, not of a rendering of
 * them: two different PDFs can render to identical text, and a poppler upgrade
 * would otherwise change a document's identity. `documents/` likewise keeps the
 * original bytes — §3 calls it "raw uploaded PDFs".
 */
function readDocument(file: string, convertPdf: PdfConverter = pdftotextConverter): { raw: Buffer; text: string } {
  if (!existsSync(file)) throw new Error(`ingest: no such file ${file}`);
  const raw = readFileSync(file);
  if (!file.toLowerCase().endsWith(".pdf")) return { raw, text: raw.toString("utf8") };
  return { raw, text: convertPdf(file) };
}

export function cmdIngest(options: IngestOptions): IngestResult {
  const store = openStore(options.dataRoot, options.householdId);
  const ledger = store.loadLedger();
  const vault = store.loadVault();
  const createdAt = options.now();
  // Runs already on disk are not yet in the ledger, so they must be seeded in
  // too or a second ingest can reuse the first run's id and overwrite it.
  const ids = ledgerIds(ledger, createdAt, store.listAllRunIds());

  const { raw, text: rawText } = readDocument(options.file, options.convertPdf);
  const sha256 = createHash("sha256").update(raw).digest("hex");
  const documentPath = store.storeDocument(basename(options.file), raw, sha256);

  // This command is the offline path: the deterministic extractor, no egress.
  // Live model extraction is cmdIngestLive, which is async and audited.
  const offline = options.offline ?? !options.apiKey;
  if (!offline) {
    throw new Error("ingest: live extraction is asynchronous — call cmdIngestLive, or pass --offline");
  }
  let run: ParseRun;
  try {
    run = executeParseRun({
      rawText,
      filename: basename(options.file),
      ledger,
      vault,
      ids,
      createdAt,
    });
  } catch (error) {
    // §5.3: a document we cannot turn into schema-valid output is parked for
    // manual entry rather than silently dropped. Persist the vault first —
    // redaction may have allocated account tokens, and §5.2 requires them to
    // stay stable whether or not the parse succeeded.
    store.saveVault(vault);
    const runId = ids();
    store.parkRun(runId, {
      "error.txt": `${(error as Error).message}\n`,
      "source.txt": rawText,
    });
    throw new Error(
      `ingest: could not parse ${basename(options.file)} — parked in parse-runs/failed/${runId} for manual entry. ${(error as Error).message}`
    );
  }

  // The vault may have allocated new account tokens during redaction.
  store.saveVault(vault);

  const meta: RunMeta = {
    runId: run.id,
    filename: run.filename,
    sha256,
    createdAt,
    documentPath,
  };
  const reviewHtml = renderReviewHtml(run, ledger);
  const runDir = store.saveRun(run.id, {
    "run.json": JSON.stringify(meta, null, 2) + "\n",
    "parse-output.json": JSON.stringify(run.output, null, 2) + "\n",
    "review.html": reviewHtml,
  });

  return {
    runId: run.id,
    reviewPath: join(runDir, "review.html"),
    usedNetwork: false,
    extractor: "deterministic (offline)",
    accountsFound: run.output.accounts.length,
  };
}

/** Live extraction path — separate because it is async and touches the network. */
export async function cmdIngestLive(options: IngestOptions & { apiKey: string }): Promise<IngestResult> {
  const store = openStore(options.dataRoot, options.householdId);
  const vault = store.loadVault();
  const createdAt = options.now();
  const { raw, text: rawText } = readDocument(options.file, options.convertPdf);
  const auditPath = options.auditPath ?? join(process.cwd(), "NETWORK_AUDIT.md");

  const { redactStatement } = await import("../ingest/redact.ts");
  const redacted = redactStatement(rawText, vault);
  const output = await extractWithClaude(redacted, {
    vault,
    apiKey: options.apiKey,
    fetchFn: fetch,
    appendAudit: fileAuditAppender(auditPath),
    now: options.now,
    ...(options.offline ? { offline: true } : {}),
  });
  store.saveVault(vault);

  // Re-run the deterministic pipeline steps over the model's output.
  const ledger = store.loadLedger();
  const ids = ledgerIds(ledger, createdAt, store.listAllRunIds());
  const sha256 = createHash("sha256").update(raw).digest("hex");
  const documentPath = store.storeDocument(basename(options.file), raw, sha256);
  const run: ParseRun = {
    id: ids(),
    filename: basename(options.file),
    sha256,
    created_at: createdAt,
    redactedText: redacted,
    output,
    matches: matchInstruments(output, ledger),
  };
  const runDir = store.saveRun(run.id, {
    "run.json": JSON.stringify({ runId: run.id, filename: run.filename, sha256, createdAt, documentPath } satisfies RunMeta, null, 2) + "\n",
    "parse-output.json": JSON.stringify(run.output, null, 2) + "\n",
    "review.html": renderReviewHtml(run, ledger),
  });
  return {
    runId: run.id,
    reviewPath: join(runDir, "review.html"),
    usedNetwork: true,
    extractor: "claude",
    accountsFound: output.accounts.length,
  };
}

// --- review -----------------------------------------------------------------

export interface DecisionsFile {
  operator_initials?: string;
  lines?: {
    kind?: string;
    ref: string;
    action?: "accept" | "reject";
    note?: string;
    instrumentId?: string;
    confirmMetadata?: MetadataConfirmation;
    edits?: LineDecision["edits"];
  }[];
}

export interface ReviewOptions extends BaseOptions {
  householdId: string;
  runId: string;
  acceptAll?: boolean;
  /** Reverse a previous acceptance of this run and apply it again. */
  reaccept?: boolean;
  decisionsPath?: string;
  /** Map of instrument name → confirmed metadata (SPEC §7.1 gate). */
  confirmMetadataPath?: string;
  operatorInitials?: string;
}

export interface ReviewResult {
  accepted: number;
  rejected: number;
  edited: number;
  metadataConfirmed: number;
  reaccepted?: boolean;
}

/**
 * Removes everything a previous acceptance of this run put into the ledger, so
 * the run can be applied again cleanly. Instruments are deliberately left in
 * place: they may be referenced by other documents, and an instrument carries
 * operator-confirmed metadata that should survive a re-review.
 */
export function reverseAcceptance(ledger: Ledger, documentId: string, runId: string): void {
  const removedFxSources = new Set(
    ledger.documents.filter((d) => d.id === documentId).map((d) => `statement:${d.filename.replace(/\.txt$/, "")}`)
  );
  ledger.documents = ledger.documents.filter((d) => d.id !== documentId);
  ledger.holdings = ledger.holdings.filter((h) => h.source_document_id !== documentId);
  ledger.transactions = ledger.transactions.filter((t) => t.source_document_id !== documentId);
  ledger.acceptances = ledger.acceptances.filter((a) => a.document_id !== documentId && a.parse_run_id !== runId);
  ledger.fx_rates = ledger.fx_rates.filter((r) => !removedFxSources.has(r.source));
  // An account's freshness must fall back to whatever evidence still stands.
  for (const account of ledger.accounts) {
    const remaining = ledger.holdings.filter((h) => h.account_id === account.id).map((h) => h.asof).sort();
    if (remaining.length) account.data_asof = remaining[remaining.length - 1]!;
  }
}

export function cmdReview(options: ReviewOptions): ReviewResult {
  const store = openStore(options.dataRoot, options.householdId);
  const ledger = store.loadLedger();
  const { output, meta } = store.loadRun(options.runId);
  const acceptedAt = options.now();

  // §5.6 models one acceptance per run. Applying a run twice adds a second
  // document, duplicate fee transactions and a duplicate appendix entry — the
  // cost-stack headline moves by the full duplicated amount, with no error.
  const priorDocument = ledger.documents.find((d) => d.parse_run_ids.includes(options.runId));
  if (priorDocument) {
    if (!options.reaccept) {
      throw new Error(
        `review: run ${options.runId} was already accepted at ${priorDocument.accepted_at ?? "an earlier time"} (document ${priorDocument.id}). Re-run with --reaccept to reverse that acceptance and apply it again.`
      );
    }
    reverseAcceptance(ledger, priorDocument.id, options.runId);
  }

  const ids = ledgerIds(ledger, acceptedAt, store.listAllRunIds());

  const decisions: DecisionsFile = options.decisionsPath
    ? (JSON.parse(readFileSync(options.decisionsPath, "utf8")) as DecisionsFile)
    : {};
  if (!options.acceptAll && !options.decisionsPath) {
    throw new Error(
      `review: open ${join(store.runDir(options.runId), "review.html")} then re-run with --decisions <file> or --accept-all`
    );
  }
  const metadataByName: Record<string, MetadataConfirmation> = options.confirmMetadataPath
    ? (JSON.parse(readFileSync(options.confirmMetadataPath, "utf8")) as Record<string, MetadataConfirmation>)
    : {};

  const byRef = new Map((decisions.lines ?? []).map((line) => [line.ref, line]));
  const tally: ReviewResult = { accepted: 0, rejected: 0, edited: 0, metadataConfirmed: 0 };

  const decide = (line: LineRef): LineDecision => {
    const explicit = byRef.get(line.ref);
    const confirmation = line.kind === "holding" ? metadataByName[line.ref] : undefined;
    if (explicit?.action === "reject") {
      tally.rejected++;
      return { action: "reject", ...(explicit.note ? { note: explicit.note } : {}) };
    }
    if (explicit?.edits) tally.edited++;
    else tally.accepted++;
    const merged = explicit?.confirmMetadata ?? confirmation;
    if (merged) tally.metadataConfirmed++;
    return {
      action: "accept",
      ...(explicit?.edits ? { edits: explicit.edits } : {}),
      ...(explicit?.instrumentId ? { instrumentId: explicit.instrumentId } : {}),
      ...(merged ? { confirmMetadata: merged } : {}),
      ...(explicit?.note ? { note: explicit.note } : {}),
    };
  };

  const run: ParseRun = {
    id: meta.runId,
    filename: meta.filename,
    sha256: meta.sha256,
    created_at: meta.createdAt,
    redactedText: "",
    output,
    matches: [],
  };
  run.matches = matchInstruments(output, ledger);

  acceptRun(ledger, run, store.config, ids, {
    acceptedAt,
    operatorInitials: options.operatorInitials ?? decisions.operator_initials ?? "OP",
    decide,
  });
  store.saveLedger(ledger);
  store.saveRun(options.runId, {
    "accepted.json": JSON.stringify({ acceptedAt, accepted: true, tally }, null, 2) + "\n",
  });
  return options.reaccept ? { ...tally, reaccepted: true } : tally;
}

// --- report -----------------------------------------------------------------

export interface ReportOptions extends BaseOptions {
  householdId: string;
  asof: string;
  paramsRoot?: string;
}

export function cmdReport(options: ReportOptions): { resultsPath: string; results: Results; store: HouseholdStore } {
  const store = openStore(options.dataRoot, options.householdId);
  const ledger = store.loadLedger();
  const results = buildResults({
    ledger,
    asof: options.asof,
    generatedAt: options.now(),
    ...(options.paramsRoot ? { paramsRoot: options.paramsRoot } : {}),
  });
  const resultsPath = store.saveReport(`results-${options.asof}.json`, JSON.stringify(results, null, 2) + "\n");
  return { resultsPath, results, store };
}
