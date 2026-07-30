// Redaction engine (SPEC §5.2): local-only replacement of direct identifiers
// with stable tokens before anything can leave the machine. The vault maps raw
// values to tokens and must only ever be written to data/{household}/
// vault.local.json (mode 600) — never committed, never transmitted.
import { writeFileSync, readFileSync, existsSync } from "node:fs";

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
export function assertRedacted(text: string, vault: Vault): void {
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
  if (hits.length) throw new RedactionError([...new Set(hits)]);
}

export function saveVault(path: string, vault: Vault): void {
  writeFileSync(path, JSON.stringify(vault, null, 2) + "\n", { mode: 0o600 });
}

export function loadVault(path: string): Vault | null {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8")) as Vault;
}
