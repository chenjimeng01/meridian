// Parse-run orchestration for a single document: fingerprint the raw bytes,
// redact, extract (deterministic fixture parser by default; the LLM extractor
// is injected for real documents), validate, and match instruments.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import { redactStatement, type Vault } from "./redact.ts";
import { parseFixtureStatement } from "./extract-fixture.ts";
import { matchInstruments } from "./match.ts";
import type { IdFactory, Ledger, ParseOutput, ParseRun } from "./types.ts";

const SCHEMA_PATH = join(dirname(fileURLToPath(import.meta.url)), "../../schema/parse-output.schema.json");
const ajv = new Ajv2020({ strict: true, strictRequired: false });
const validateParseOutput = ajv.compile(JSON.parse(readFileSync(SCHEMA_PATH, "utf8")));

export interface ParseRunInput {
  rawText: string;
  filename: string;
  ledger: Ledger;
  vault: Vault;
  ids: IdFactory;
  /** ISO timestamp of this run; injected at the CLI boundary (SPEC §2, §6). */
  createdAt: string;
  extract?: (redactedText: string) => ParseOutput;
}

export function executeParseRun(input: ParseRunInput): ParseRun {
  const extract = input.extract ?? parseFixtureStatement;
  const sha256 = createHash("sha256").update(input.rawText).digest("hex");
  const redactedText = redactStatement(input.rawText, input.vault);
  const output = extract(redactedText);
  if (!validateParseOutput(output)) {
    throw new Error(
      `parse output failed schema validation for ${input.filename}: ${JSON.stringify(validateParseOutput.errors)}`
    );
  }
  return {
    id: input.ids(),
    filename: input.filename,
    sha256,
    created_at: input.createdAt,
    redactedText,
    output,
    matches: matchInstruments(output, input.ledger),
  };
}
