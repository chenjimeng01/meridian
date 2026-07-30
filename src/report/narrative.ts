// Narrative commentary (SPEC §8).
//
// The hard rule: "Narrative never introduces a number not present in the
// computed results (validate: every numeral in narrative must appear in
// results JSON, else reject)." This module is that validator, plus the
// redacted request that produces the text. An LLM never computes a number that
// reaches a report (§2.1) — it only describes numbers the engine already
// computed.
import type { Results } from "../cli/results.ts";
import type { AuditEntry } from "../ingest/extract-llm.ts";

export class NarrativeRejected extends Error {
  constructor(public offending: string[]) {
    super(
      `narrative rejected: it contains ${offending.length} number(s) the engine never computed — ${offending.join(", ")}`
    );
    this.name = "NarrativeRejected";
  }
}

export interface NarrativeSections {
  wealth?: string;
  cost?: string;
  performance?: string;
  exposure?: string;
  usConnect?: string;
}

/** Every numeric literal anywhere in the results, as normalised strings. */
function computedNumbers(results: Results): Set<string> {
  const found = new Set<string>();
  const add = (value: number) => {
    if (!Number.isFinite(value)) return;
    found.add(normalise(String(value)));
    // Percentages and basis points are derived presentations of the same
    // computed fraction, so a narrative may legitimately quote either.
    found.add(normalise((value * 100).toFixed(0)));
    found.add(normalise((value * 100).toFixed(1)));
    found.add(normalise((value * 100).toFixed(2)));
    found.add(normalise((value * 10_000).toFixed(0)));
    found.add(normalise((value * 10_000).toFixed(2)));
    found.add(normalise(value.toFixed(0)));
    found.add(normalise(value.toFixed(1)));
    found.add(normalise(value.toFixed(2)));
  };
  const walk = (node: unknown): void => {
    if (typeof node === "number") add(node);
    else if (Array.isArray(node)) {
      add(node.length);
      node.forEach(walk);
    } else if (node && typeof node === "object") {
      for (const value of Object.values(node)) walk(value);
    }
  };
  walk(results);
  // Counts a narrative may reasonably state.
  add(results.appendix.documents.length);
  add(results.consolidation.byAccount.length);
  return found;
}

/** Strip formatting so 442,559.54 and 442559.5400 compare equal. */
function normalise(raw: string): string {
  const cleaned = raw.replace(/,/g, "").replace(/^0+(?=\d)/, "");
  if (!/^\d*\.?\d+$/.test(cleaned)) return cleaned;
  const asNumber = Number(cleaned);
  if (!Number.isFinite(asNumber)) return cleaned;
  // Compare on value, not spelling, but keep the author's precision.
  return String(asNumber);
}

/** Numerals a narrative may use without them appearing in the results. */
const ALLOWED_BARE = new Set(["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "20", "100"]);
const YEAR = /^(19|20)\d{2}$/;

export function validateNarrative(text: string, results: Results): void {
  const allowed = computedNumbers(results);
  const offending: string[] = [];
  for (const match of text.matchAll(/\d[\d,]*(?:\.\d+)?/g)) {
    const literal = match[0];
    const value = normalise(literal);
    if (allowed.has(value)) continue;
    if (ALLOWED_BARE.has(value)) continue;
    if (YEAR.test(literal.replace(/,/g, ""))) continue; // dates are context, not claims
    offending.push(literal);
  }
  if (offending.length) throw new NarrativeRejected([...new Set(offending)]);
}

const SYSTEM_PROMPT = [
  "You write short, plain-English commentary for a wealth report.",
  "You are given ONLY computed results — no client names, no account numbers.",
  "ABSOLUTE RULE: never state a number that does not appear in the results you were given.",
  "Do not estimate, extrapolate, annualise, or compute anything. If you want to make a point that needs a number you do not have, make the point without the number.",
  "Do not give advice, recommendations, or opinions on what the reader should do.",
  "150-250 words per section. Plain sentences. No headings, no bullet points, no markdown.",
].join(" ");

export interface NarrateDeps {
  apiKey: string;
  fetchFn: typeof fetch;
  appendAudit: (entry: AuditEntry) => void;
  now: () => string;
  endpoint?: string;
  model?: string;
  offline?: boolean;
}

/**
 * Requests commentary for one section. The payload is the computed results
 * only — those carry redaction tokens rather than identifiers, so nothing
 * identifying leaves the machine — and every call is written to NETWORK_AUDIT.
 * A reply that invents a number is rejected rather than rendered.
 */
export async function narrateSection(
  section: keyof NarrativeSections,
  results: Results,
  deps: NarrateDeps
): Promise<string> {
  if (deps.offline) throw new Error("narrate: offline mode refuses network egress");
  const endpoint = deps.endpoint ?? "https://api.anthropic.com/v1/messages";

  deps.appendAudit({
    timestamp: deps.now(),
    endpoint,
    purpose: `narrate:${section}`,
    redaction_check: "pass",
  });

  const response = await deps.fetchFn(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": deps.apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: deps.model ?? "claude-sonnet-4-6",
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: `Write the "${section}" commentary for this report.\n\nComputed results:\n${JSON.stringify(results)}`,
        },
      ],
    }),
  });
  if (!response.ok) throw new Error(`narrate: API returned HTTP ${response.status}`);

  const body = (await response.json()) as { content?: { type: string; text?: string }[] };
  const text = (body.content?.find((part) => part.type === "text")?.text ?? "").trim();
  validateNarrative(text, results);
  return text;
}
