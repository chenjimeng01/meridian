#!/usr/bin/env node
// SPEC §9 pre-commit rail: scans staged files (or files passed as arguments)
// for personal-data patterns and for any raw string recorded in a local vault.
// Exits 1 on a hit, refusing the commit.
//
// Two defects were found here by a compliance review, both of which made the
// headline promise ("refuses any commit containing a value recorded in a local
// vault") false in practice:
//
//   1. The collector walked Object.values(). But the vault stores raw
//      identifiers as KEYS — `persons: { "Jane Smith": "P1" }`,
//      `accounts: { "12345678": "A1" }` — so client names and account numbers
//      were never collected and never scanned. Only `addresses` (an array)
//      was ever checked.
//   2. Vault discovery was hardcoded to <repo>/data, so any operator using a
//      different data root (scripts/demo.sh honours MERIDIAN_DATA_ROOT) got no
//      vault scanning at all.
//
// Both are fixed below and pinned by test/precommit-scan.test.ts.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// The six fictional account numbers used by the synthetic fixtures (NOTICE §2).
// Allowlisting the *values* rather than whole paths keeps the rule sharp: a
// real account number is refused anywhere in the repo, tests included.
const SYNTHETIC_ACCOUNT_NUMBERS = new Set([
  "ALD-4471902",
  "ALD-4471903",
  "BST-118834",
  "774-20991",
  "HPB-0055271",
  "HPB-0055272",
]);

const PATTERNS = [
  { name: "UK National Insurance number", re: /\b[A-CEGHJ-PR-TW-Z]{2}[0-9]{6}[A-D]\b/g },
  { name: "US Social Security number", re: /\b\d{3}-\d{2}-\d{4}\b/g },
  { name: "UK sort code + account number", re: /\b\d{2}-\d{2}-\d{2}\b[^\n]{0,20}\b\d{8}\b/g },
  {
    name: "institution account number",
    re: /\b[A-Z0-9]{2,4}-\d{5,8}\b/g,
    allowValues: SYNTHETIC_ACCOUNT_NUMBERS,
  },
];

/** Every data root a vault might live under, most specific first. */
export function vaultRoots() {
  const roots = [];
  if (process.env.MERIDIAN_DATA_ROOT) roots.push(resolve(process.env.MERIDIAN_DATA_ROOT));
  roots.push(join(ROOT, "data"));
  roots.push(join(ROOT, "demo-data"));
  roots.push(resolve(process.cwd(), "data"));
  return [...new Set(roots)];
}

/**
 * The vault fields that hold real identifiers, and where in each the secret
 * lives. `persons` and `accounts` map REAL THING → TOKEN, so the secret is the
 * key; `addresses` is a plain list.
 *
 * This is deliberately explicit rather than a generic walk. A generic walk
 * collected the structural keys too ("persons", "accounts", "addresses"), so
 * any file containing the word "accounts" was refused — and a rail that cries
 * wolf gets switched off, which is worse than the hole it was fixing.
 *
 * VAULT_FIELDS must cover every identifier-bearing field in the Vault type
 * (src/ingest/redact.ts). test/precommit-scan.test.ts fails if a new one
 * appears without being listed here.
 */
export const VAULT_FIELDS = {
  persons: "keys",
  accounts: "keys",
  addresses: "values",
};

/** Fields that carry no personal data and would only add false positives. */
export const VAULT_NON_SECRET_FIELDS = ["version", "salt", "next_account"];

export function collectVaultStrings(vault) {
  const out = new Set();
  const MIN_LENGTH = 4;
  const keep = (value) => {
    if (typeof value === "string" && value.length >= MIN_LENGTH) out.add(value);
  };
  for (const [field, where] of Object.entries(VAULT_FIELDS)) {
    const node = vault?.[field];
    if (!node) continue;
    if (where === "keys") Object.keys(node).forEach(keep);
    else if (Array.isArray(node)) node.forEach(keep);
    else Object.values(node).forEach(keep);
  }
  return [...out];
}

function vaultStrings() {
  const out = [];
  for (const dataRoot of vaultRoots()) {
    if (!existsSync(dataRoot)) continue;
    for (const entry of readdirSync(dataRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const vaultPath = join(dataRoot, entry.name, "vault.local.json");
      if (!existsSync(vaultPath)) continue;
      try {
        out.push(...collectVaultStrings(JSON.parse(readFileSync(vaultPath, "utf8"))));
      } catch {
        // An unreadable vault cannot be scanned against; that is reported
        // rather than silently ignored, because a broken vault means the rail
        // is not doing its job.
        console.error(`WARNING: could not read ${vaultPath} — it was NOT scanned against`);
      }
    }
  }
  return [...new Set(out)];
}

function stagedFiles() {
  const raw = execFileSync("git", ["diff", "--cached", "--name-only", "--diff-filter=ACM", "-z"], {
    cwd: ROOT,
  }).toString();
  return raw.split("\0").filter(Boolean);
}

const args = process.argv.slice(2);
const files = args.length ? args : stagedFiles();
const vaultRaw = vaultStrings();
let failed = false;

for (const file of files) {
  const path = resolve(ROOT, file);
  if (!existsSync(path) || statSync(path).isDirectory()) continue;
  let content;
  try {
    content = readFileSync(path, "utf8");
  } catch {
    continue; // binary or unreadable
  }
  for (const { name, re, allowValues } of PATTERNS) {
    for (const [hit] of content.matchAll(re)) {
      if (allowValues?.has(hit)) continue;
      console.error(`BLOCKED: ${file} matches ${name} pattern ("${hit}")`);
      failed = true;
      break;
    }
  }
  const lower = content.toLowerCase();
  for (const raw of vaultRaw) {
    if (lower.includes(raw.toLowerCase())) {
      console.error(`BLOCKED: ${file} contains "${raw}", a value recorded in a local vault`);
      failed = true;
      break;
    }
  }
}

if (failed) {
  console.error("\nCommit refused (SPEC §9). Remove the personal data or move it under data/ (gitignored).");
  process.exit(1);
}
