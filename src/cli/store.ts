// Local-first household store (SPEC §2.2, §3). Everything is a file:
//
//   data/{household-id}/
//     ├── documents/          raw ingested documents, named by sha256
//     ├── ledger.json         the canonical ledger
//     ├── vault.local.json    redaction map — mode 600, never committed
//     ├── household.json      base/secondary currency, persons, tax profiles
//     ├── parse-runs/         one directory per run, plus failed/
//     └── reports/            generated results and reports
//
// This module owns all disk I/O for the CLI so the engine and ingest modules
// stay pure.
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createVault, loadVault, saveVault, type Vault } from "../ingest/redact.ts";
import { serializeLedger, type HouseholdConfig } from "../ingest/accept.ts";
import type { Ledger, ParseOutput } from "../ingest/types.ts";

export interface HouseholdStore {
  id: string;
  dir: string;
  config: HouseholdConfig;
  loadLedger(): Ledger;
  saveLedger(ledger: Ledger): void;
  loadVault(): Vault;
  saveVault(vault: Vault): void;
  storeDocument(filename: string, contents: Buffer, sha256: string): string;
  runDir(runId: string): string;
  saveRun(runId: string, files: Record<string, string>): string;
  parkRun(runId: string, files: Record<string, string>): string;
  listRuns(): string[];
  listAllRunIds(): string[];
  listParkedRuns(): string[];
  loadParkedRun(runId: string): { source: string; error: string };
  loadRun(runId: string): { output: ParseOutput; meta: RunMeta };
  saveReport(name: string, contents: string): string;
}

export interface RunMeta {
  runId: string;
  filename: string;
  sha256: string;
  createdAt: string;
  documentPath: string;
  accepted?: boolean;
}

const SUBDIRS = ["documents", "parse-runs", "reports"];

/**
 * The household config with direct identifiers removed. Tokens, tax profiles
 * and account ownership are needed to run the pipeline; real names and
 * addresses are not, and belong only in the vault (SPEC §5.2, §9).
 */
export function stripIdentifiers(config: HouseholdConfig & { addresses?: string[] }): HouseholdConfig {
  const { addresses: _addresses, ...rest } = config as HouseholdConfig & { addresses?: string[] };
  void _addresses;
  return {
    ...rest,
    persons: config.persons.map((person) => ({ ...person, names: [] })),
  };
}

const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Ids become path segments. A run id of "../../etc" would otherwise let a
 * mistyped or hostile argument read and write outside the household.
 */
export function assertSafeId(id: string, what: string): string {
  if (!SAFE_ID.test(id)) {
    throw new Error(`${what} "${id}" is not a valid id — expected letters, digits, hyphen or underscore`);
  }
  return id;
}

export function householdDir(dataRoot: string, householdId: string): string {
  assertSafeId(householdId, "household id");
  return join(dataRoot, householdId);
}

export function listHouseholds(dataRoot: string): { id: string; config: HouseholdConfig }[] {
  if (!existsSync(dataRoot)) return [];
  return readdirSync(dataRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(dataRoot, entry.name, "household.json")))
    .map((entry) => ({
      id: entry.name,
      config: JSON.parse(readFileSync(join(dataRoot, entry.name, "household.json"), "utf8")) as HouseholdConfig,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function createHousehold(
  dataRoot: string,
  householdId: string,
  config: HouseholdConfig & { addresses?: string[] },
  ledger: Ledger,
  salt: string
): HouseholdStore {
  const dir = householdDir(dataRoot, householdId);
  if (existsSync(join(dir, "household.json"))) {
    throw new Error(`household ${householdId} already exists at ${dir}`);
  }
  mkdirSync(dir, { recursive: true });
  for (const sub of SUBDIRS) mkdirSync(join(dir, sub), { recursive: true });
  // SPEC §5.2: names and addresses live in the vault and NOWHERE else. Writing
  // the operator's config verbatim would leave a second, world-readable copy of
  // exactly what the vault's mode-600 rail exists to protect.
  writeFileSync(join(dir, "household.json"), JSON.stringify(stripIdentifiers(config), null, 2) + "\n");
  chmodSync(join(dir, "household.json"), 0o600);
  writeFileSync(join(dir, "ledger.json"), serializeLedger(ledger));
  saveVault(join(dir, "vault.local.json"), createVault(config, salt));
  return openStore(dataRoot, householdId);
}

export function openStore(dataRoot: string, householdId: string): HouseholdStore {
  const dir = householdDir(dataRoot, householdId);
  if (!existsSync(join(dir, "household.json"))) {
    throw new Error(`no household ${householdId} under ${dataRoot} — run "meridian households create" first`);
  }
  const config = JSON.parse(readFileSync(join(dir, "household.json"), "utf8")) as HouseholdConfig;

  const write = (base: string, runId: string, files: Record<string, string>) => {
    const target = join(dir, "parse-runs", base, runId);
    mkdirSync(target, { recursive: true });
    for (const [name, contents] of Object.entries(files)) {
      writeFileSync(join(target, name), contents);
    }
    return target;
  };

  return {
    id: householdId,
    dir,
    config,
    loadLedger: () => JSON.parse(readFileSync(join(dir, "ledger.json"), "utf8")) as Ledger,
    saveLedger: (ledger) => writeFileSync(join(dir, "ledger.json"), serializeLedger(ledger)),
    loadVault: () => {
      const vault = loadVault(join(dir, "vault.local.json"));
      if (!vault) throw new Error(`household ${householdId} has no vault — refusing to redact without one`);
      return vault;
    },
    saveVault: (vault) => saveVault(join(dir, "vault.local.json"), vault),
    storeDocument: (filename, contents, sha256) => {
      // Content-addressed: re-ingesting the same document cannot duplicate it.
      const ext = filename.slice(filename.lastIndexOf(".")) || ".txt";
      const path = join(dir, "documents", `${sha256}${ext}`);
      if (!existsSync(path)) {
        writeFileSync(path, contents);
        chmodSync(path, 0o600);
      }
      return path;
    },
    runDir: (runId) => join(dir, "parse-runs", runId),
    saveRun: (runId, files) => {
      const target = join(dir, "parse-runs", runId);
      mkdirSync(target, { recursive: true });
      for (const [name, contents] of Object.entries(files)) writeFileSync(join(target, name), contents);
      return target;
    },
    parkRun: (runId, files) => {
      const target = write("failed", assertSafeId(runId, "run id"), files);
      // The parked source is the RAW, unredacted document — same sensitivity as
      // documents/, so the same mode.
      for (const name of Object.keys(files)) chmodSync(join(target, name), 0o600);
      return target;
    },
    listRuns: () => {
      const runsDir = join(dir, "parse-runs");
      if (!existsSync(runsDir)) return [];
      return readdirSync(runsDir, { withFileTypes: true })
        .filter((e) => e.isDirectory() && e.name !== "failed")
        .map((e) => e.name)
        .sort();
    },
    // Every run id ever minted, parked ones included. Ids must be seeded from
    // this, not listRuns(): a parked run is persisted state, and a factory that
    // cannot see it will reissue its id and overwrite the parked document —
    // silent loss on the one path §5.3 exists to prevent.
    listAllRunIds: () => {
      const runsDir = join(dir, "parse-runs");
      if (!existsSync(runsDir)) return [];
      const ids = readdirSync(runsDir, { withFileTypes: true })
        .filter((e) => e.isDirectory() && e.name !== "failed")
        .map((e) => e.name);
      const failedDir = join(runsDir, "failed");
      if (existsSync(failedDir)) {
        for (const entry of readdirSync(failedDir, { withFileTypes: true })) {
          if (entry.isDirectory()) ids.push(entry.name);
        }
      }
      return ids.sort();
    },
    listParkedRuns: () => {
      const failedDir = join(dir, "parse-runs", "failed");
      if (!existsSync(failedDir)) return [];
      return readdirSync(failedDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort();
    },
    loadParkedRun: (runId) => {
      const target = join(dir, "parse-runs", "failed", assertSafeId(runId, "run id"));
      if (!existsSync(join(target, "source.txt"))) {
        throw new Error(`no parked run ${runId} for household ${householdId}`);
      }
      return {
        source: readFileSync(join(target, "source.txt"), "utf8"),
        error: existsSync(join(target, "error.txt")) ? readFileSync(join(target, "error.txt"), "utf8") : "",
      };
    },
    loadRun: (runId) => {
      const target = join(dir, "parse-runs", assertSafeId(runId, "run id"));
      if (!existsSync(join(target, "run.json"))) {
        throw new Error(`no parse run ${runId} for household ${householdId}`);
      }
      return {
        output: JSON.parse(readFileSync(join(target, "parse-output.json"), "utf8")) as ParseOutput,
        meta: JSON.parse(readFileSync(join(target, "run.json"), "utf8")) as RunMeta,
      };
    },
    saveReport: (name, contents) => {
      const path = join(dir, "reports", name);
      writeFileSync(path, contents);
      return path;
    },
  };
}
