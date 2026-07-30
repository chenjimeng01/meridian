import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROOT } from "./helpers.ts";
import { collectVaultStrings, VAULT_FIELDS, VAULT_NON_SECRET_FIELDS } from "../scripts/precommit-scan.mjs";
import { readFileSync as read } from "node:fs";

// SPEC §9's rail, and the promise README makes about it: "refuses any commit
// containing personal-data patterns or a value recorded in a local vault".
//
// A compliance review found that promise was false. The collector walked
// Object.values(), but a vault stores raw identifiers as KEYS — the mapping is
// "real thing" → "token", so the secret is on the left — meaning client names
// and account numbers were never scanned. Vault discovery was also hardcoded
// to <repo>/data, so any other data root got no scanning at all. The repo was
// public by then. These tests exist so neither can regress silently.

const SCANNER = join(ROOT, "scripts/precommit-scan.mjs");

function scan(files: string[], dataRoot?: string): { code: number; stderr: string } {
  try {
    execFileSync(process.execPath, [SCANNER, ...files], {
      cwd: ROOT,
      encoding: "utf8",
      env: { ...process.env, ...(dataRoot ? { MERIDIAN_DATA_ROOT: dataRoot } : {}) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, stderr: "" };
  } catch (error: any) {
    return { code: error.status ?? 1, stderr: String(error.stderr ?? "") };
  }
}

function withVault<T>(fn: (ctx: { dataRoot: string; write: (name: string, body: string) => string }) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "meridian-scan-"));
  try {
    mkdirSync(join(dir, "data", "HOUSEHOLD1"), { recursive: true });
    writeFileSync(
      join(dir, "data", "HOUSEHOLD1", "vault.local.json"),
      JSON.stringify({
        version: 1,
        salt: "01SALTSALTSALT",
        persons: { "Jonathan Fairbanks": "P1", "J Fairbanks": "P2" },
        accounts: { "98765432109876": "A1" },
        addresses: ["9 Real Street", "Bristol BS1 4AA"],
        next_account: 2,
      })
    );
    return fn({
      dataRoot: join(dir, "data"),
      write: (name, body) => {
        const path = join(dir, name);
        writeFileSync(path, body);
        return path;
      },
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a client NAME recorded in the vault blocks the commit (§9)", () => {
  withVault(({ dataRoot, write }) => {
    const file = write("note.txt", "Suitability note: Jonathan Fairbanks is comfortable with the risk.\n");
    const result = scan([file], dataRoot);
    assert.equal(result.code, 1, "a vault name must refuse the commit");
    assert.match(result.stderr, /Jonathan Fairbanks/);
    assert.match(result.stderr, /recorded in a local vault/);
  });
});

test("a client ACCOUNT NUMBER recorded in the vault blocks the commit (§9)", () => {
  withVault(({ dataRoot, write }) => {
    const file = write("ledger-note.txt", "Balance check against 98765432109876 completed.\n");
    assert.equal(scan([file], dataRoot).code, 1);
  });
});

test("an address recorded in the vault blocks the commit (§9)", () => {
  withVault(({ dataRoot, write }) => {
    const file = write("letter.txt", "Correspondence sent to 9 Real Street.\n");
    assert.equal(scan([file], dataRoot).code, 1);
  });
});

test("the rail honours the data root actually in use, not just the repo's own", () => {
  withVault(({ dataRoot, write }) => {
    const file = write("note.txt", "Jonathan Fairbanks\n");
    // With the data root supplied, blocked...
    assert.equal(scan([file], dataRoot).code, 1);
    // ...and the failure mode that mattered: pointed elsewhere, the scanner
    // finds no vault and therefore cannot protect anything. This asserts the
    // dependency explicitly so nobody assumes the rail is root-independent.
    assert.equal(scan([file], join(dataRoot, "nonexistent")).code, 0);
  });
});

test("clean content passes, so the rail is usable", () => {
  withVault(({ dataRoot, write }) => {
    const file = write("clean.txt", "Total wealth consolidated across six accounts.\n");
    assert.equal(scan([file], dataRoot).code, 0);
  });
});

test("structural patterns still block, with or without a vault", () => {
  withVault(({ dataRoot, write }) => {
    const ni = ["AB", "123456", "C"].join("");
    assert.equal(scan([write("ni.txt", `nino ${ni}\n`)], dataRoot).code, 1);
    const accountProbe = ["XYZ", "9988776"].join("-");
    assert.equal(scan([write("acct.txt", `ref ${accountProbe}\n`)], dataRoot).code, 1);
  });
});

test("the committed synthetic fixtures still pass, so the rail is not merely strict", () => {
  const fixtures = [
    "test/fixtures/statements/alderbrook-platform/valuation-2026-06.txt",
    "scripts/gen-fixtures.mjs",
    "README.md",
  ].map((rel) => join(ROOT, rel));
  assert.equal(scan(fixtures).code, 0);
});

test("the collector does not treat the vault's STRUCTURE as secret", () => {
  // A generic walk collected "persons", "accounts" and "addresses" too, so any
  // file containing the word "accounts" was refused. A rail that cries wolf
  // gets switched off, which is worse than the hole it was fixing.
  const strings = collectVaultStrings({
    version: 1,
    salt: "x",
    persons: { "Jane Smith": "P1" },
    accounts: { "12345678": "A1" },
    addresses: ["4 Somewhere Lane"],
    next_account: 2,
  });
  for (const structural of ["persons", "accounts", "addresses", "version", "salt", "next_account"]) {
    assert.ok(!strings.includes(structural), `"${structural}" is structure, not a secret`);
  }
});

test("every identifier-bearing vault field is covered by the scanner", () => {
  // If the Vault type gains a field holding real data and nobody wires it in
  // here, the rail silently stops protecting it. This fails loudly instead.
  const source = read(join(ROOT, "src/ingest/redact.ts"), "utf8");
  const block = source.slice(source.indexOf("export interface Vault"));
  const fields = [...block.slice(0, block.indexOf("}")).matchAll(/^\s*(\w+)[?]?:/gm)].map((m) => m[1]!);
  assert.ok(fields.length >= 5, `guard: expected to parse the Vault interface, got ${fields.join(", ")}`);
  const covered = new Set([...Object.keys(VAULT_FIELDS), ...VAULT_NON_SECRET_FIELDS]);
  for (const field of fields) {
    assert.ok(covered.has(field), `Vault.${field} is neither scanned nor declared non-secret in precommit-scan.mjs`);
  }
});

test("collectVaultStrings reads KEYS as well as values — the whole defect", () => {
  const strings = collectVaultStrings({
    version: 1,
    salt: "notasecret",
    persons: { "Jane Smith": "P1" },
    accounts: { "12345678": "A1" },
    addresses: ["4 Somewhere Lane"],
    next_account: 2,
  });
  assert.ok(strings.includes("Jane Smith"), "the person's real name is a KEY and must be collected");
  assert.ok(strings.includes("12345678"), "the real account number is a KEY and must be collected");
  assert.ok(strings.includes("4 Somewhere Lane"));
  assert.ok(!strings.includes("notasecret"), "the salt is not a secret and would only add noise");
});
