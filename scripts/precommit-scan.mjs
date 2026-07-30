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

const PATTERNS = [
  { name: "UK National Insurance number", re: /\b[A-CEGHJ-PR-TW-Z]{2}[0-9]{6}[A-D]\b/ },
  { name: "US Social Security number", re: /\b\d{3}-\d{2}-\d{4}\b/ },
  { name: "UK sort code + account number", re: /\b\d{2}-\d{2}-\d{2}\b[^\n]{0,20}\b\d{8}\b/ },
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
  for (const { name, re } of PATTERNS) {
    if (re.test(content)) {
      console.error(`BLOCKED: ${file} matches ${name} pattern`);
      failed = true;
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
