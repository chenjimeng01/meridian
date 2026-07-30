// Live extraction path (SPEC §5.3): redacted document → Claude → schema-valid
// parse output. Hard rules: assertRedacted gates every call; every call is
// recorded via appendAudit; one retry with validation errors appended; still
// invalid → ParkedError (document goes to parse-runs/failed/ for manual entry).
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import { assertRedacted, type Vault } from "./redact.ts";
import type { ParseOutput } from "./types.ts";

const SCHEMA_PATH = join(dirname(fileURLToPath(import.meta.url)), "../../schema/parse-output.schema.json");
const parseOutputSchema = JSON.parse(readFileSync(SCHEMA_PATH, "utf8"));
const ajv = new Ajv2020({ strict: true, strictRequired: false });
const validateParseOutput = ajv.compile(parseOutputSchema);

export class OfflineError extends Error {
  constructor() {
    super("offline mode: network egress is disabled — use manual entry");
    this.name = "OfflineError";
  }
}

export class ParkedError extends Error {
  constructor(public validationErrors: string) {
    super(`extraction parked for manual entry after retry; validation errors: ${validationErrors}`);
    this.name = "ParkedError";
  }
}

export interface AuditEntry {
  timestamp: string;
  endpoint: string;
  purpose: string;
  redaction_check: "pass";
  /**
   * Which household and document. Without these the log cannot answer "whose
   * data went to the API on 3 March", which is the question it exists for and
   * which Art. 33 gives 72 hours to answer.
   */
  household_id?: string;
  document_ref?: string;
}

export interface ExtractDeps {
  vault: Vault;
  apiKey: string;
  fetchFn: typeof fetch;
  appendAudit: (entry: AuditEntry) => void;
  now: () => string;
  offline?: boolean;
  endpoint?: string;
  model?: string;
  purpose?: string;
}

const SYSTEM_PROMPT = [
  "You extract structured data from redacted financial statements.",
  "Return ONLY a JSON object conforming exactly to the provided JSON Schema — no prose, no markdown fences.",
  "Extract only what the document shows; never invent identifiers, units or values that are not printed.",
  "Account references are redaction tokens (A1, A2…); reproduce them verbatim.",
  "Score each figure's confidence honestly in [0,1]; note ambiguities in warnings[].",
].join(" ");

export async function extractWithClaude(redactedText: string, deps: ExtractDeps): Promise<ParseOutput> {
  if (deps.offline) throw new OfflineError();
  assertRedacted(redactedText, deps.vault);

  const endpoint = deps.endpoint ?? "https://api.anthropic.com/v1/messages";
  const model = deps.model ?? "claude-sonnet-4-6";
  let priorErrors: string | null = null;

  for (let attempt = 0; attempt < 2; attempt++) {
    const userContent: string = [
      "JSON Schema for your reply:",
      JSON.stringify(parseOutputSchema),
      priorErrors
        ? `Your previous reply failed schema validation with these errors — correct them:\n${priorErrors}`
        : "",
      "Redacted document:",
      redactedText,
    ]
      .filter(Boolean)
      .join("\n\n");

    deps.appendAudit({
      timestamp: deps.now(),
      endpoint,
      purpose: deps.purpose ?? "extract",
      redaction_check: "pass",
    });

    const res: Response = await deps.fetchFn(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": deps.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: 8192,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: userContent }],
      }),
    });
    if (!res.ok) {
      priorErrors = `API error: HTTP ${res.status}`;
      continue;
    }
    const body = (await res.json()) as { content?: { type: string; text?: string }[] };
    const text = body.content?.find((c) => c.type === "text")?.text ?? "";
    let candidate: unknown;
    try {
      candidate = JSON.parse(text);
    } catch (e) {
      priorErrors = `reply was not valid JSON: ${(e as Error).message}`;
      continue;
    }
    if (validateParseOutput(candidate)) return candidate as ParseOutput;
    priorErrors = JSON.stringify(validateParseOutput.errors);
  }
  throw new ParkedError(priorErrors ?? "unknown");
}
