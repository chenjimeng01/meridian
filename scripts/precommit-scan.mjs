#!/usr/bin/env node
// SPEC §9 pre-commit rail: scans staged files (or files passed as arguments)
// for personal-data patterns and for raw strings recorded in any local vault
// file. Exits 1 on a hit, refusing the commit. Fictional fixture data passes:
// the scan targets structural PII patterns and vault-recorded real values.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
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
  // §9's headline pattern: the institution-prefixed account-number shape that
  // redact.ts exists to tokenise.
  {
    name: "institution account number",
    re: /\b[A-Z0-9]{2,4}-\d{5,8}\b/g,
    allowValues: SYNTHETIC_ACCOUNT_NUMBERS,
  },
];

// Raw values held in any local vault must never reach a commit.
function vaultStrings() {
  const out = [];
  const dataDir = join(ROOT, "data");
  if (!existsSync(dataDir)) return out;
  for (const household of readdirSync(dataDir, { withFileTypes: true })) {
    if (!household.isDirectory()) continue;
    const vaultPath = join(dataDir, household.name, "vault.local.json");
    if (!existsSync(vaultPath)) continue;
    try {
      const vault = JSON.parse(readFileSync(vaultPath, "utf8"));
      const collect = (node) => {
        if (typeof node === "string" && node.length >= 4) out.push(node);
        else if (node && typeof node === "object") Object.values(node).forEach(collect);
      };
      collect(vault.raw ?? vault);
    } catch {
      // unreadable vault: nothing to scan against
    }
  }
  return out;
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
  if (!existsSync(path)) continue;
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
      console.error(`BLOCKED: ${file} contains a value recorded in a local vault`);
      failed = true;
      break;
    }
  }
}

if (failed) {
  console.error("\nCommit refused (SPEC §9). Remove the personal data or move it under data/ (gitignored).");
  process.exit(1);
}
