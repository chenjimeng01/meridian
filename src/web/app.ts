// Meridian in the browser (GitHub Pages build).
//
// GitHub Pages is static hosting: there is no server, and this app never sends
// a statement anywhere. It runs the SAME deterministic engine the CLI runs —
// the identical redaction, parser, consolidation, PFIC cascade and report
// renderer — compiled to run in the page. "Upload" here means "read the file
// you picked", nothing more. That is what makes a hosted interface compatible
// with §2.2's local-first rule at all.
//
// State lives in memory for the session. Nothing is written to a server, and
// nothing is persisted unless you press Download.
import Ajv2020 from "ajv/dist/2020.js";

import { createVault, redactStatement, primeRedactionVocabulary, type Vault } from "../ingest/redact.ts";
import { parseFixtureStatement } from "../ingest/extract-fixture.ts";
import { matchInstruments } from "../ingest/match.ts";
import { initHousehold, acceptRun, type HouseholdConfig } from "../ingest/accept.ts";
import { renderReviewHtml } from "../ingest/review-html.ts";
import type { Ledger, MetadataConfirmation, ParseOutput, ParseRun } from "../ingest/types.ts";
import { buildResults, type Results } from "../cli/results.ts";
import { renderReport } from "../report/render.ts";

import parseOutputSchema from "../../schema/parse-output.schema.json" with { type: "json" };
import redactionVocabulary from "../../params/shared/redaction-vocabulary.json" with { type: "json" };
import assetClasses from "../../params/shared/asset-classes.json" with { type: "json" };
import fxPolicy from "../../params/shared/fx-policy.json" with { type: "json" };
import wrapperMatrix from "../../params/shared/wrapper-matrix.json" with { type: "json" };
import pficRules from "../../params/shared/pfic-rules.json" with { type: "json" };
import situsRules from "../../params/shared/situs-rules.json" with { type: "json" };
import currencyOfLifeRules from "../../params/shared/currency-of-life.json" with { type: "json" };
import usParams from "../../params/us/2026.json" with { type: "json" };
import ukParams from "../../params/uk/2026-27.json" with { type: "json" };
import cpiUk from "../../params/shared/benchmarks/cpi_uk.json" with { type: "json" };
import cpiUs from "../../params/shared/benchmarks/cpi_us.json" with { type: "json" };
import globalEquity from "../../params/shared/benchmarks/global_equity_gbp.json" with { type: "json" };
import globalBonds from "../../params/shared/benchmarks/global_bonds_gbp.json" with { type: "json" };
import usEquity from "../../params/shared/benchmarks/us_equity_usd.json" with { type: "json" };
import gbpCash from "../../params/shared/benchmarks/gbp_cash.json" with { type: "json" };

import demoConfig from "../../test/fixtures/household-config.json" with { type: "json" };
import demoMetadata from "../../test/fixtures/instrument-metadata.json" with { type: "json" };
import { DEMO_STATEMENTS } from "./demo-statements.ts";

primeRedactionVocabulary(redactionVocabulary);

const PARAMS: Record<string, unknown> = {
  "shared/asset-classes.json": assetClasses,
  "shared/fx-policy.json": fxPolicy,
  "shared/wrapper-matrix.json": wrapperMatrix,
  "shared/pfic-rules.json": pficRules,
  "shared/situs-rules.json": situsRules,
  "shared/currency-of-life.json": currencyOfLifeRules,
  "us/2026.json": usParams,
  "uk/2026-27.json": ukParams,
  "shared/benchmarks/cpi_uk.json": cpiUk,
  "shared/benchmarks/cpi_us.json": cpiUs,
  "shared/benchmarks/global_equity_gbp.json": globalEquity,
  "shared/benchmarks/global_bonds_gbp.json": globalBonds,
  "shared/benchmarks/us_equity_usd.json": usEquity,
  "shared/benchmarks/gbp_cash.json": gbpCash,
};

const ajv = new (Ajv2020 as unknown as typeof import("ajv/dist/2020.js").Ajv2020)({
  strict: true,
  strictRequired: false,
  allErrors: true,
});
const validateParseOutput = ajv.compile(parseOutputSchema as object);

// --- session state ----------------------------------------------------------

interface Loaded {
  id: string;
  filename: string;
  sha256: string;
  run: ParseRun;
  accepted: boolean;
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

// The counter is module-level, not part of `state`: initHousehold mints ids
// while the state object is still being constructed, so it cannot live there.
let idCounter = 0;

function nextId(): string {
  // Deterministic within a session; the browser build has no ledger to seed
  // from and needs only uniqueness, not unpredictability.
  let n = ++idCounter;
  let suffix = "";
  for (let i = 0; i < 16; i++) {
    suffix = CROCKFORD[n % 32] + suffix;
    n = Math.floor(n / 32);
  }
  return "01MERWEB00" + suffix;
}

interface SessionState {
  config: HouseholdConfig;
  vault: Vault;
  ledger: Ledger;
  loaded: Loaded[];
  metadata: Record<string, MetadataConfirmation>;
}

function freshState(config: HouseholdConfig): SessionState {
  idCounter = 0;
  return {
    config,
    vault: createVault(config as any, "browser-session"),
    ledger: initHousehold(config, nextId),
    loaded: [],
    metadata: {},
  };
}

let state: SessionState = freshState(demoConfig as unknown as HouseholdConfig);

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function resetSession(config: HouseholdConfig): void {
  state = freshState(config);
}

// --- pipeline ---------------------------------------------------------------

async function addStatement(filename: string, text: string): Promise<Loaded> {
  const fingerprint = await sha256(text);
  const redacted = redactStatement(text, state.vault);
  const output = parseFixtureStatement(redacted) as ParseOutput;

  if (!validateParseOutput(output)) {
    throw new Error(
      `${filename} could not be read as a statement. In the desktop tool it would be parked for manual entry. ` +
        `(${ajv.errorsText(validateParseOutput.errors).slice(0, 160)})`
    );
  }
  if (!output.accounts.length || output.accounts.every((a) => !a.holdings?.length && !a.cash_balance && !a.fees?.length)) {
    throw new Error(`${filename} parsed, but no holdings, cash or charges were found in it.`);
  }

  const run: ParseRun = {
    id: nextId(),
    filename,
    sha256: fingerprint,
    created_at: new Date().toISOString(),
    redactedText: redacted,
    output,
    matches: matchInstruments(output, state.ledger),
  };
  const loaded: Loaded = { id: run.id, filename, sha256: fingerprint, run, accepted: false };
  state.loaded.push(loaded);
  return loaded;
}

function acceptAll(): void {
  const acceptedAt = new Date().toISOString();
  for (const entry of state.loaded) {
    if (entry.accepted) continue;
    acceptRun(state.ledger, entry.run, state.config, nextId, {
      acceptedAt,
      operatorInitials: (document.getElementById("operator") as HTMLInputElement)?.value?.trim() || "OP",
      decide: (line) => {
        const confirmation = line.kind === "holding" ? state.metadata[line.ref] : undefined;
        return confirmation ? { action: "accept", confirmMetadata: confirmation } : { action: "accept" };
      },
    });
    entry.accepted = true;
  }
}

function buildReport(): { results: Results; html: string } {
  const asof =
    (document.getElementById("asof") as HTMLInputElement)?.value ||
    [...state.ledger.holdings.map((h) => h.asof)].sort().at(-1) ||
    new Date().toISOString().slice(0, 10);

  const results = buildResults({
    ledger: state.ledger,
    asof,
    generatedAt: new Date().toISOString(),
    readParams: (rel: string) => {
      const doc = PARAMS[rel];
      if (!doc) throw new Error(`this build does not bundle params/${rel}`);
      return doc;
    },
    benchmark: { weights: { global_equity_gbp: 0.6, global_bonds_gbp: 0.4 } },
  });
  return { results, html: renderReport(results) };
}

// --- UI ---------------------------------------------------------------------

const $ = (id: string) => document.getElementById(id)!;
const esc = (value: unknown) =>
  String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function say(message: string, tone: "info" | "error" = "info"): void {
  const box = $("messages");
  const line = document.createElement("p");
  line.className = tone === "error" ? "msg msg-error" : "msg";
  line.textContent = message;
  box.prepend(line);
}

function renderStatements(): void {
  const list = $("statements");
  if (!state.loaded.length) {
    list.innerHTML = `<p class="muted">No statements yet. Add one, or load the worked example.</p>`;
    $("step-review").setAttribute("hidden", "");
    return;
  }
  $("step-review").removeAttribute("hidden");

  list.innerHTML = state.loaded
    .map((entry) => {
      const src = entry.run.output.source;
      const lines = entry.run.output.accounts.reduce(
        (total, account) =>
          total + (account.holdings?.length ?? 0) + (account.fees?.length ?? 0) + (account.cash_balance ? 1 : 0),
        0
      );
      return `<div class="card">
        <div class="row">
          <strong>${esc(src.institution || entry.filename)}</strong>
          <span class="chip">${entry.accepted ? "accepted" : "ready to review"}</span>
        </div>
        <p class="small muted">${esc(src.doc_type.replace(/_/g, " "))} · ${esc(src.period.from)} → ${esc(src.period.to)} ·
        ${lines} line${lines === 1 ? "" : "s"} · accounts ${esc(entry.run.output.accounts.map((a) => a.account_token).join(", "))}</p>
        <p class="small mono muted">${esc(entry.sha256.slice(0, 16))}…</p>
        <button type="button" class="ghost" data-review="${esc(entry.id)}">Open the review screen</button>
      </div>`;
    })
    .join("");

  for (const button of list.querySelectorAll<HTMLButtonElement>("[data-review]")) {
    button.addEventListener("click", () => {
      const entry = state.loaded.find((item) => item.id === button.dataset.review);
      if (entry) openFrame(renderReviewHtml(entry.run, state.ledger), `Review — ${entry.filename}`);
    });
  }
  renderInstruments();
}

/** Instruments whose type and domicile must be confirmed before §7.1 will run. */
function renderInstruments(): void {
  const names = new Map<string, string>();
  for (const entry of state.loaded) {
    for (const account of entry.run.output.accounts) {
      for (const holding of account.holdings ?? []) names.set(holding.name, holding.identifiers?.isin ?? "");
    }
  }
  const box = $("instruments");
  if (!names.size) {
    box.innerHTML = "";
    return;
  }
  box.innerHTML =
    `<p class="small muted">Until an instrument's type and domicile are confirmed it is reported as
     "needs classification" rather than assumed safe — that is what unlocks the US/UK tax analysis.</p>` +
    [...names.entries()]
      .map(([name, isin]) => {
        const current = state.metadata[name];
        return `<label class="instrument">
        <span>${esc(name)}${isin ? ` <span class="small mono muted">${esc(isin)}</span>` : ""}</span>
        <select data-instrument="${esc(name)}">
          <option value="">not confirmed</option>
          ${["equity", "bond", "cash", "oeic", "ucits_etf", "investment_trust", "mutual_fund_us", "us_etf", "mmf", "other_pooled"]
            .map((type) => `<option value="${type}"${current?.type === type ? " selected" : ""}>${type.replace(/_/g, " ")}</option>`)
            .join("")}
        </select>
        <input type="text" maxlength="2" placeholder="GB" value="${esc(current?.domicile ?? "")}"
               data-domicile="${esc(name)}" aria-label="Domicile for ${esc(name)}">
        <label class="reg"><input type="checkbox" data-registered="${esc(name)}"
               ${current?.us_registered ? "checked" : ""}> US-registered fund</label>
      </label>`;
      })
      .join("");

  const sync = () => {
    for (const select of box.querySelectorAll<HTMLSelectElement>("[data-instrument]")) {
      const name = select.dataset.instrument!;
      const domicile = box.querySelector<HTMLInputElement>(`[data-domicile="${CSS.escape(name)}"]`)?.value.toUpperCase().trim();
      const registered = box.querySelector<HTMLInputElement>(`[data-registered="${CSS.escape(name)}"]`)?.checked;
      if (!select.value) delete state.metadata[name];
      else {
        state.metadata[name] = {
          type: select.value,
          ...(domicile ? { domicile } : {}),
          us_registered: Boolean(registered),
        };
      }
    }
  };
  box.addEventListener("change", sync);
}

function openFrame(html: string, title: string): void {
  const frame = $("viewer") as HTMLIFrameElement;
  frame.srcdoc = html;
  $("viewer-title").textContent = title;
  $("viewer-panel").removeAttribute("hidden");
  $("viewer-panel").scrollIntoView({ behavior: "smooth", block: "start" });
}

function download(filename: string, contents: string, type: string): void {
  const url = URL.createObjectURL(new Blob([contents], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

let lastReport: { results: Results; html: string } | null = null;

function wire(): void {
  $("file").addEventListener("change", async (event) => {
    const input = event.target as HTMLInputElement;
    for (const file of [...(input.files ?? [])]) {
      try {
        if (/\.pdf$/i.test(file.name)) {
          throw new Error(
            `${file.name} is a PDF. This browser build reads text statements; convert it first (the desktop tool uses pdftotext).`
          );
        }
        const entry = await addStatement(file.name, await file.text());
        say(`Read ${file.name}: ${entry.run.output.accounts.length} account(s). Nothing left this browser.`);
      } catch (error) {
        say((error as Error).message, "error");
      }
    }
    input.value = "";
    renderStatements();
  });

  $("paste-add").addEventListener("click", async () => {
    const text = ($("paste") as HTMLTextAreaElement).value;
    if (!text.trim()) return say("Paste a statement first.", "error");
    try {
      await addStatement("pasted statement", text);
      ($("paste") as HTMLTextAreaElement).value = "";
      say("Read the pasted statement.");
    } catch (error) {
      say((error as Error).message, "error");
    }
    renderStatements();
  });

  $("demo").addEventListener("click", async () => {
    resetSession(demoConfig as unknown as HouseholdConfig);
    state.metadata = { ...(demoMetadata as Record<string, MetadataConfirmation>) };
    delete (state.metadata as Record<string, unknown>).comment;
    for (const [filename, text] of Object.entries(DEMO_STATEMENTS)) {
      try {
        await addStatement(filename, text);
      } catch (error) {
        say(`${filename}: ${(error as Error).message}`, "error");
      }
    }
    say(`Loaded ${state.loaded.length} synthetic statements from 5 fictional institutions.`);
    renderStatements();
  });

  $("accept").addEventListener("click", () => {
    try {
      acceptAll();
      say(`Accepted. The ledger now holds ${state.ledger.holdings.length} positions across ${state.ledger.accounts.length} accounts.`);
      $("step-report").removeAttribute("hidden");
      renderStatements();
    } catch (error) {
      say((error as Error).message, "error");
    }
  });

  $("report").addEventListener("click", () => {
    try {
      lastReport = buildReport();
      openFrame(lastReport.html, "Client report");
      const flags = (lastReport.results.usConnect as { criticalCount?: number } | null)?.criticalCount;
      say(
        `Report built: ${lastReport.results.consolidation.total.base.currency} ` +
          `${lastReport.results.consolidation.total.base.amount.toLocaleString("en-GB")}` +
          (flags === undefined ? "" : ` · ${flags} critical US flag(s)`)
      );
      $("downloads").removeAttribute("hidden");
    } catch (error) {
      say((error as Error).message, "error");
    }
  });

  $("dl-report").addEventListener("click", () => {
    if (lastReport) download("meridian-report.html", lastReport.html, "text/html");
  });
  $("dl-results").addEventListener("click", () => {
    if (lastReport) download("meridian-results.json", JSON.stringify(lastReport.results, null, 2), "application/json");
  });
  $("dl-ledger").addEventListener("click", () => {
    download("meridian-ledger.json", JSON.stringify(state.ledger, null, 2), "application/json");
  });
  $("reset").addEventListener("click", () => {
    resetSession(demoConfig as unknown as HouseholdConfig);
    lastReport = null;
    $("step-report").setAttribute("hidden", "");
    $("downloads").setAttribute("hidden", "");
    $("viewer-panel").setAttribute("hidden", "");
    $("messages").innerHTML = "";
    say("Session cleared. Nothing was stored anywhere.");
    renderStatements();
  });

  renderStatements();
}

document.addEventListener("DOMContentLoaded", wire);
