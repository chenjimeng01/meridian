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
  constructor(
    public offending: string[],
    reason = "it contains figures the engine never computed"
  ) {
    super(`narrative rejected: ${reason} — ${offending.join("; ")}`);
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

/** Small counts a narrative may use as prose without smuggling precision. */
const ALLOWED_BARE = new Set(["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "20", "100"]);

/**
 * Scale words turn a permitted small number into an arbitrary large one:
 * "1.5 million" passes a digit check while stating a figure the engine never
 * produced. There is no legitimate use for them when every real figure is
 * available exactly.
 */
const SCALE_WORDS = /\b(?:thousand|million|billion|trillion|k|bn|m)\b/i;

/**
 * Spelled-out numbers are the same smuggling route without digits. Small words
 * are harmless prose ("four accounts"); anything that can compose a magnitude
 * is not.
 */
const NUMBER_WORDS =
  /\b(?:thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|hundreds|dozens?)\b/i;

export function validateNarrative(text: string, results: Results): void {
  const allowed = computedNumbers(results);
  const offending: string[] = [];

  if (SCALE_WORDS.test(text)) offending.push("a scale word (thousand/million/billion)");
  if (NUMBER_WORDS.test(text)) offending.push("a spelled-out magnitude");

  // A four-digit run is only a date if the results actually contain it — the
  // old blanket year exemption let any amount between 1900 and 2099 through,
  // so "£1,950" and "£2,050" were both accepted. Whole ISO dates present in the
  // results are removed first, so their parts are not read as loose numbers.
  const serialised = JSON.stringify(results);
  let scannable = text;
  for (const date of new Set(text.match(/\d{4}-\d{2}-\d{2}/g) ?? [])) {
    if (serialised.includes(date)) scannable = scannable.split(date).join(" ");
  }

  for (const match of scannable.matchAll(/\d[\d,]*(?:\.\d+)?/g)) {
    const literal = match[0];
    const value = normalise(literal);
    if (allowed.has(value)) continue;
    if (ALLOWED_BARE.has(value)) continue;
    if (/^(?:19|20)\d{2}$/.test(literal) && serialised.includes(literal)) continue;
    offending.push(literal);
  }
  if (offending.length) throw new NarrativeRejected([...new Set(offending)]);
}

/**
 * §9 puts the product on the information side of the advice boundary, and the
 * report footer says so. A prompt instruction is not a control; this is.
 */
const ADVICE_PHRASES =
  /\b(?:you should|we recommend|I recommend|recommendation|you (?:ought|need) to|consider (?:selling|buying|switching|moving)|it would be (?:wise|sensible|prudent)|advise|advisable|best course)\b/i;

export function assertNoAdvice(text: string): void {
  const match = text.match(ADVICE_PHRASES);
  if (match) {
    throw new NarrativeRejected(
      [`"${match[0]}"`],
      "it reads as a personal recommendation, which §9 puts outside this product"
    );
  }
}

const SYSTEM_PROMPT = [
  "You write short, plain-English commentary for a wealth report.",
  "You are given ONLY computed results — no client names, no account numbers.",
  "ABSOLUTE RULE: never state a number that does not appear in the results you were given.",
  "Do not estimate, extrapolate, annualise, or compute anything. If you want to make a point that needs a number you do not have, make the point without the number.",
  "Do not give advice, recommendations, or opinions on what the reader should do.",
  "150-250 words per section. Plain sentences. No headings, no bullet points, no markdown.",
].join(" ");

/**
 * The payload sent for commentary. Results carry redaction tokens rather than
 * names, but `appendix.documents[].filename` is the operator's own file naming
 * — which routinely contains a client's name. It is stripped here, and the
 * result is asserted clean before anything leaves the machine.
 */
export function redactResultsForNarration(results: Results): Results {
  return {
    ...results,
    meta: { ...results.meta },
    appendix: {
      ...results.appendix,
      documents: results.appendix.documents.map((document) => ({
        ...document,
        filename: `${document.institution} ${document.doc_type} ${document.period.to}`,
      })),
    },
  };
}

const TOKEN_SHAPES = [/^P\d+$/, /^A\d+$/];

/**
 * Egress gate for narration (SPEC §2.2, §9). The extractor has assertRedacted;
 * this is its equivalent. Writing `redaction_check: "pass"` to NETWORK_AUDIT
 * without actually checking would make the audit log worse than useless.
 */
export function assertNarrationSafe(payload: Results, forbidden: Iterable<string> = []): void {
  const serialised = JSON.stringify(payload);
  const hits: string[] = [];
  for (const value of forbidden) {
    if (value && serialised.toLowerCase().includes(value.toLowerCase())) hits.push(value);
  }
  // Any person or account reference must be a token, never a name.
  for (const match of serialised.matchAll(/"(?:personToken|account_token|accountToken|display_token)":"([^"]+)"/g)) {
    const token = match[1]!;
    if (!TOKEN_SHAPES.some((shape) => shape.test(token))) hits.push(token);
  }
  // Real filenames contain spaces — "Eleanor Vance Q2 statement.pdf" is the
  // normal case, and a character class of [A-Za-z0-9_.-] missed every one of
  // them. The client's name is frequently IN the filename, so this is the
  // detector that matters most.
  if (/[/\\][^"\\/]{0,120}\.(?:pdf|txt|csv|xlsx?|docx?)/i.test(serialised)) {
    hits.push("a file path");
  }
  if (hits.length) {
    throw new Error(
      `narrate: refusing to transmit — payload still contains ${[...new Set(hits)].join(", ")}`
    );
  }
}

export interface NarrateDeps {
  apiKey: string;
  fetchFn: typeof fetch;
  appendAudit: (entry: AuditEntry) => void;
  now: () => string;
  endpoint?: string;
  model?: string;
  offline?: boolean;
  /** Extra strings that must not appear in the payload (e.g. vault names). */
  forbiddenStrings?: string[];
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

  // Strip, then CHECK, then log the check — in that order. The audit row is
  // only written once the assertion has actually passed.
  const payload = redactResultsForNarration(results);
  assertNarrationSafe(payload, deps.forbiddenStrings ?? []);

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
          content: `Write the "${section}" commentary for this report.\n\nComputed results:\n${JSON.stringify(payload)}`,
        },
      ],
    }),
  });
  if (!response.ok) throw new Error(`narrate: API returned HTTP ${response.status}`);

  const body = (await response.json()) as { content?: { type: string; text?: string }[] };
  const text = (body.content?.find((part) => part.type === "text")?.text ?? "").trim();
  validateNarrative(text, results);
  assertNoAdvice(text);
  return text;
}
