// Generates test/golden/ingested-ledger.json by running the full ingestion
// pipeline over the 15 fixture statements in canonical order with
// deterministic IDs. Run via: npm run gen:golden
// The committed golden is immutable thereafter (deny-listed for agents);
// regenerate ONLY for a deliberate, reviewed pipeline-contract change.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createVault } from "../src/ingest/redact.ts";
import { initHousehold, acceptRun, serializeLedger } from "../src/ingest/accept.ts";
import { executeParseRun } from "../src/ingest/run.ts";
import { sequentialIds } from "../src/ingest/ids.ts";
import { INGEST_ORDER } from "../src/ingest/order.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const config = JSON.parse(readFileSync(join(ROOT, "test/fixtures/household-config.json"), "utf8"));

const ids = sequentialIds();
const vault = createVault(config, "fixture-salt");
const ledger = initHousehold(config, ids);
for (const rel of INGEST_ORDER) {
  const rawText = readFileSync(join(ROOT, "test/fixtures/statements", rel), "utf8");
  const run = executeParseRun({ rawText, filename: rel, ledger, vault, ids });
  acceptRun(ledger, run, config, ids);
}

mkdirSync(join(ROOT, "test/golden"), { recursive: true });
const out = join(ROOT, "test/golden/ingested-ledger.json");
writeFileSync(out, serializeLedger(ledger));
console.log(
  `Wrote ${out}: ${ledger.accounts.length} accounts, ${ledger.instruments.length} instruments, ` +
    `${ledger.holdings.length} holdings, ${ledger.transactions.length} transactions, ${ledger.documents.length} documents.`
);
