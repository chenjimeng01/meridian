// Redaction engine (SPEC §5.2): local-only replacement of direct identifiers
// with stable tokens before anything can leave the machine. The vault maps raw
// values to tokens and must only ever be written to data/{household}/
// vault.local.json (mode 600) — never committed, never transmitted.
import { writeFileSync, readFileSync, existsSync, chmodSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export interface Vault {
  version: 1;
  salt: string;
  persons: Record<string, string>; // raw name variant → person token
  accounts: Record<string, string>; // raw account number → account token
  addresses: string[];
  next_account: number;
}

export class RedactionError extends Error {
  constructor(public hits: string[]) {
    super(`redaction assertion failed: ${hits.join("; ")}`);
    this.name = "RedactionError";
  }
}

const ACCOUNT_RE = /\b[A-Z0-9]{2,4}-\d{5,8}\b/g;
const NI_RE = /\b[A-CEGHJ-PR-TW-Z]{2}\d{6}[A-D]\b/g;
const SSN_RE = /\b\d{3}-\d{2}-\d{4}\b/g;
const POSTCODE_RE = /\b[A-Z]{1,2}\d[A-Z\d]?\s?\d[A-Z]{2}\b/g;
const HONORIFIC_RE = /\b(?:MRS|MISS|MR|MS|DR)\.?\s+(P\d+)\b/gi;

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// --- Unknown proper-noun detection (SPEC §5.2 "regex + NER pass") ----------
// Deterministic stand-in for a trained NER model: a run of capitalised tokens
// containing no vocabulary token is treated as an unrecognised personal name
// and hard-fails before egress. It never silently redacts — it forces the
// operator to extend the vault (a real name) or the vocabulary (a legitimate
// institution/instrument/place). Rules and word lists live in params.
const VOCAB_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../params/shared/redaction-vocabulary.json"
);

interface VocabDoc {
  policy: { min_run_length: { value: number } };
  safe_tokens: Record<string, string[] | string>;
}

let vocabCache: { safe: Set<string>; minRun: number } | null = null;

/**
 * Supplies the vocabulary directly instead of reading it from disk. The
 * browser build calls this at start-up: the rules are identical, they just
 * arrive as a bundled import rather than a file read.
 */
export function primeRedactionVocabulary(doc: unknown): void {
  vocabCache = null;
  loadVocabulary(doc as VocabDoc);
}

function loadVocabulary(doc: VocabDoc): { safe: Set<string>; minRun: number } {
  const safe = new Set<string>();
  for (const [key, list] of Object.entries(doc.safe_tokens)) {
    if (key === "comment" || !Array.isArray(list)) continue;
    for (const token of list) safe.add(token.toUpperCase());
  }
  vocabCache = { safe, minRun: doc.policy.min_run_length.value };
  return vocabCache;
}

function vocabulary(): { safe: Set<string>; minRun: number } {
  if (vocabCache) return vocabCache;
  const doc = JSON.parse(readFileSync(VOCAB_PATH, "utf8")) as VocabDoc;
  return loadVocabulary(doc);
}

const stripEdges = (token: string) => token.replace(/^[([{"'`]+/, "").replace(/[)\]},.;:!?"'`]+$/, "");
const letterCount = (token: string) => (token.match(/[A-Za-z]/g) ?? []).length;
const isCapitalisedWord = (token: string) => /^[A-Z]/.test(token) && letterCount(token) >= 2;

export function findUnknownProperNouns(text: string, extraSafe: Iterable<string> = []): string[] {
  const { safe, minRun } = vocabulary();
  const allowed = new Set(safe);
  for (const token of extraSafe) allowed.add(token.toUpperCase());

  const flagged = new Set<string>();
  for (const line of text.split("\n")) {
    let run: string[] = [];
    const flush = () => {
      if (run.length >= minRun && !run.some((t) => allowed.has(t.toUpperCase()))) {
        flagged.add(run.join(" "));
      }
      run = [];
    };
    for (const rawToken of line.split(/\s+/)) {
      const token = stripEdges(rawToken);
      if (token && isCapitalisedWord(token)) run.push(token);
      else flush();
    }
    flush();
  }
  return [...flagged];
}

export function createVault(
  config: { persons: { token: string; names: string[] }[]; addresses?: string[] },
  salt: string
): Vault {
  const persons: Record<string, string> = {};
  for (const p of config.persons) for (const name of p.names) persons[name] = p.token;
  return { version: 1, salt, persons, accounts: {}, addresses: config.addresses ?? [], next_account: 1 };
}

export function redactStatement(text: string, vault: Vault): string {
  let out = text;
  for (const [name, token] of Object.entries(vault.persons)) {
    out = out.replace(new RegExp(escapeRe(name), "gi"), token);
  }
  out = out.replace(HONORIFIC_RE, "$1");
  for (const addr of vault.addresses) {
    out = out.replace(new RegExp(escapeRe(addr), "gi"), "[ADDRESS]");
  }
  out = out.replace(POSTCODE_RE, "[POSTCODE]");
  out = out.replace(ACCOUNT_RE, (raw) => {
    if (!vault.accounts[raw]) vault.accounts[raw] = `A${vault.next_account++}`;
    return vault.accounts[raw];
  });
  out = out.replace(NI_RE, "[NI]").replace(SSN_RE, "[SSN]");
  return out;
}

// Hard gate before any network egress: if anything identifying survives,
// throw. Called by the live extractor before every single API call.
// `extraSafe` lets the caller admit vocabulary it knows is legitimate for this
// document (e.g. the institution's own name); it can only ever be additive to
// the params vocabulary, and never suppresses a structural-pattern hit.
export function assertRedacted(text: string, vault: Vault, extraSafe: Iterable<string> = []): void {
  const hits: string[] = [];
  if (text.match(ACCOUNT_RE)) hits.push("raw account-number pattern present");
  if (text.match(NI_RE)) hits.push("NI-number pattern present");
  if (text.match(SSN_RE)) hits.push("SSN pattern present");
  if (text.match(POSTCODE_RE)) hits.push("postcode pattern present");
  const lower = text.toLowerCase();
  for (const name of Object.keys(vault.persons)) {
    if (lower.includes(name.toLowerCase())) hits.push(`vault name present`);
  }
  for (const addr of vault.addresses) {
    if (lower.includes(addr.toLowerCase())) hits.push(`vault address present`);
  }
  for (const raw of Object.keys(vault.accounts)) {
    if (lower.includes(raw.toLowerCase())) hits.push(`vault account number present`);
  }
  // Names the operator never listed are the gap a closed vocabulary cannot
  // see: fail loudly rather than transmit an unrecognised proper noun.
  for (const run of findUnknownProperNouns(text, extraSafe)) {
    hits.push(`unrecognised proper noun "${run}" — add it to the vault (a person) or to params/shared/redaction-vocabulary.json (an institution, instrument or place)`);
  }
  if (hits.length) throw new RedactionError([...new Set(hits)]);
}

export function saveVault(path: string, vault: Vault): void {
  writeFileSync(path, JSON.stringify(vault, null, 2) + "\n", { mode: 0o600 });
  // writeFileSync applies `mode` only when creating the file; an existing
  // vault written with looser permissions would otherwise keep them.
  chmodSync(path, 0o600);
}

export function loadVault(path: string): Vault | null {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8")) as Vault;
}
