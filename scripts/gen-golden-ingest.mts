// Generates test/golden/ingested-ledger.json by running the full ingestion
// pipeline over the 15 fixture statements in canonical order with
// deterministic IDs. Run via: npm run gen:golden
// The committed golden is immutable thereafter (deny-listed for agents);
// regenerate ONLY for a deliberate, reviewed pipeline-contract change — which
// is why this script refuses to run without --force.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createVault } from "../src/ingest/redact.ts";
import { initHousehold, acceptRun, serializeLedger } from "../src/ingest/accept.ts";
import { executeParseRun } from "../src/ingest/run.ts";
import { sequentialIds } from "../src/ingest/ids.ts";
import { INGEST_ORDER } from "../src/ingest/order.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

if (!process.argv.includes("--force")) {
  console.error(
    "Refusing to rewrite test/golden/ingested-ledger.json without --force.\n" +
      "The golden is the phase gate's independent check on the pipeline; regenerating it\n" +
      "to make a failing test pass defeats the point (SPEC §12.5). If the contract change\n" +
      "is deliberate and reviewed, re-run with --force and explain it in the commit."
  );
  process.exit(1);
}

const config = JSON.parse(readFileSync(join(ROOT, "test/fixtures/household-config.json"), "utf8"));

// Fixed timestamps: the golden represents one operator session accepting all
// fifteen documents. No clock is read anywhere in the pipeline.
export const GOLDEN_PARSED_AT = "2026-07-30T11:00:00Z";
export const GOLDEN_ACCEPTED_AT = "2026-07-30T12:00:00Z";
export const GOLDEN_OPERATOR = "JC";

const ids = sequentialIds();
const vault = createVault(config, "fixture-salt");
const ledger = initHousehold(config, ids);
for (const rel of INGEST_ORDER) {
  const rawText = readFileSync(join(ROOT, "test/fixtures/statements", rel), "utf8");
  const run = executeParseRun({ rawText, filename: rel, ledger, vault, ids, createdAt: GOLDEN_PARSED_AT });
  acceptRun(ledger, run, config, ids, {
    acceptedAt: GOLDEN_ACCEPTED_AT,
    operatorInitials: GOLDEN_OPERATOR,
  });
}

mkdirSync(join(ROOT, "test/golden"), { recursive: true });
const out = join(ROOT, "test/golden/ingested-ledger.json");
writeFileSync(out, serializeLedger(ledger));
console.log(
  `Wrote ${out}: ${ledger.accounts.length} accounts, ${ledger.instruments.length} instruments, ` +
    `${ledger.holdings.length} holdings, ${ledger.transactions.length} transactions, ${ledger.documents.length} documents.`
);
