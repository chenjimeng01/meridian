import { test } from "node:test";
import assert from "node:assert/strict";
import { readJson } from "./helpers.ts";
import { buildResults } from "../src/cli/results.ts";
import { renderReport } from "../src/report/render.ts";
import { validateNarrative, NarrativeRejected } from "../src/report/narrative.ts";
import type { Ledger } from "../src/ingest/types.ts";

// SPEC §8 Phase 5 acceptance criteria:
//   "fixture household renders <400KB; Lighthouse thresholds met; offline
//    reopen works; a PFIC-free household shows no red anywhere; print preview
//    produces sane A4."

const GENERATED_AT = "2026-07-30T12:00:00Z";
const ASOF = "2026-06-30";

function resultsFor(fixture: string, benchmark?: { weights: Record<string, number> }) {
  const ledger = readJson(`test/fixtures/ledger/${fixture}.json`) as Ledger;
  return buildResults({
    ledger,
    asof: ASOF,
    generatedAt: GENERATED_AT,
    ...(benchmark ? { benchmark } : {}),
  });
}

const usukResults = resultsFor("household-usuk-acceptance", {
  weights: { global_equity_gbp: 0.6, global_bonds_gbp: 0.4 },
});
const ukOnlyResults = resultsFor("household-uk-only");

const usukHtml = renderReport(usukResults);
const ukOnlyHtml = renderReport(ukOnlyResults);

const bytes = (html: string) => Buffer.byteLength(html, "utf8");

test("the report is one self-contained file under the 400KB budget (§8)", () => {
  assert.ok(bytes(usukHtml) < 400 * 1024, `report is ${Math.round(bytes(usukHtml) / 1024)}KB, budget is 400KB`);
  assert.ok(bytes(usukHtml) > 4000, "guard: the report should not be trivially empty");
});

test("nothing is loaded from the network — no CDN, no external font, no remote image (§8)", () => {
  for (const [name, html] of [["us/uk", usukHtml], ["uk-only", ukOnlyHtml]] as const) {
    assert.equal(/<script[^>]+\bsrc\s*=/.test(html), false, `${name}: external script`);
    assert.equal(/<link[^>]+rel=["']stylesheet["']/.test(html), false, `${name}: external stylesheet`);
    assert.equal(/@import\s+url/.test(html), false, `${name}: CSS @import`);
    const remote = html.match(/https?:\/\/[^"'\s)]+/g) ?? [];
    assert.deepEqual(remote, [], `${name}: remote references ${remote.join(", ")}`);
  }
});

test("mobile-first: viewport, no horizontal scroll, 44px touch targets, 900px enhancement (§8)", () => {
  assert.match(usukHtml, /<meta name="viewport" content="width=device-width, initial-scale=1"/);
  // §8 forbids horizontal scroll on the page body; wide content scrolls inside
  // its own container instead.
  assert.match(usukHtml, /body\s*\{[^}]*overflow-x:\s*hidden/);
  assert.match(usukHtml, /\.scroll\s*\{[^}]*overflow-x:\s*auto/);
  assert.match(usukHtml, /min-height:\s*44px/, "touch targets must be at least 44px");
  assert.match(usukHtml, /@media\s*\(min-width:\s*900px\)/, "desktop is an enhancement at >=900px, not the default");
});

test("accessibility rails: reduced motion, visible focus, landmarks, labelled controls (§8)", () => {
  assert.match(usukHtml, /@media\s*\(prefers-reduced-motion:\s*reduce\)/);
  assert.match(usukHtml, /:focus-visible\s*\{/);
  assert.match(usukHtml, /<main\b/);
  assert.match(usukHtml, /lang="en"/);
  // Every chart must carry a text alternative.
  const svgs = usukHtml.match(/<svg[^>]*>/g) ?? [];
  assert.ok(svgs.length > 0, "the report should draw charts");
  for (const svg of svgs) {
    const described = /role="img"/.test(svg);
    const decorative = /aria-hidden="true"/.test(svg);
    assert.ok(described || decorative, `an SVG is neither described nor marked decorative: ${svg}`);
  }
  // Every described chart carries its own <title>; decorative bars rely on the
  // HTML label beside them, which is real, selectable text.
  const described = svgs.filter((svg) => /role="img"/.test(svg)).length;
  assert.equal((usukHtml.match(/<title>/g) ?? []).length - 1, described);
  assert.ok(usukHtml.includes("visually-hidden"), "chart captions are available to screen readers");
  // The currency toggle is a real control.
  assert.match(usukHtml, /<button[^>]+aria-pressed=/);
});

test("print: an A4 stylesheet exists and hides interactive chrome (§8)", () => {
  assert.match(usukHtml, /@media\s+print\s*\{/);
  assert.match(usukHtml, /@page\s*\{[^}]*size:\s*A4/);
  assert.match(usukHtml, /@media\s+print[\s\S]*?\.no-print[\s\S]*?display:\s*none/);
});

test("the PWA is installable and reopens offline (§8)", () => {
  // Manifest and service worker are inlined as data/blob URLs so the file stays
  // self-contained; opening it from disk must still work.
  assert.match(usukHtml, /rel="manifest"/);
  assert.match(usukHtml, /serviceWorker/);
  assert.match(usukHtml, /application\/manifest\+json/);
  // Registration must not throw when the page is opened from file:// where
  // service workers are unavailable.
  assert.match(usukHtml, /catch/);
});

test("dual currency is the signature: every headline is a stacked pair (§8)", () => {
  assert.match(usukHtml, /class="pair"/);
  assert.match(usukHtml, /£248,323\.97/);
  assert.match(usukHtml, /\$317,854\.69/);
  // Numbers always carry an explicit currency symbol — never bare.
  assert.equal(/>\s*248,323\.97\s*</.test(usukHtml), false, "a bare number with no currency symbol");
  assert.match(usukHtml, /font-variant-numeric:\s*tabular-nums/);
});

test("sections appear in the order §8 specifies", () => {
  const order = ["What you have", "What it costs", "How it has done", "What you are exposed to", "What should worry you", "Where every figure came from"];
  let cursor = -1;
  for (const heading of order) {
    const at = usukHtml.indexOf(heading);
    assert.ok(at > cursor, `section "${heading}" is missing or out of order`);
    cursor = at;
  }
});

test("the US-connected section opens with the count of critical flags, not prose (§8)", () => {
  const section = usukHtml.slice(usukHtml.indexOf("What should worry you"));
  const headlineNumber = section.match(/class="flag-count[^"]*"[^>]*>\s*(\d+)/);
  assert.ok(headlineNumber, "the section must lead with a count");
  assert.equal(Number(headlineNumber![1]), (usukResults.usConnect as any).criticalCount);
});

test("ACCEPTANCE: a PFIC-free household shows no red anywhere (§8)", () => {
  assert.equal(ukOnlyResults.usConnect, null, "guard: this household has no US person");
  assert.equal(/What should worry you/.test(ukOnlyHtml), false, "the US section is absent, not empty");

  // Red is reserved exclusively for PFIC/CRITICAL, so a household without one
  // must contain no alert red at all — not in a token, not in a swatch.
  const reds = [/#a3231b/i, /#e2554a/i, /\bcrimson\b/i, /\bred\b/i];
  for (const red of reds) {
    assert.equal(red.test(ukOnlyHtml), false, `PFIC-free report contains ${red}`);
  }
  // And the US/UK report, which does have critical flags, must use it.
  assert.ok(/#a3231b/i.test(usukHtml), "a household WITH critical flags must show the alert colour");
});

test("data freshness is shown per account, and the appendix carries source + parse date (§8 s6)", () => {
  assert.match(usukHtml, /as at/i);
  for (const doc of usukResults.appendix.documents) {
    assert.ok(usukHtml.includes(doc.filename), `appendix is missing ${doc.filename}`);
    assert.ok(usukHtml.includes(doc.sha256.slice(0, 12)), "each document's fingerprint must be shown");
  }
  assert.match(usukHtml, /parsed/i);
});

test("the regulatory footer is present verbatim (§9)", () => {
  for (const html of [usukHtml, ukOnlyHtml]) {
    assert.ok(html.includes("Not a personal recommendation"));
    assert.ok(html.includes("Not tax advice"));
    assert.ok(html.includes("elections and filings not visible to this system"));
  }
});

test("performance is labelled by method and never presented as more precise than it is (§6.2, §8)", () => {
  assert.match(usukHtml, /How it has done/);
  const method = usukResults.performance.portfolio?.method;
  if (method === "modified_dietz") assert.match(usukHtml, /estimate/i);
});

test("--deck mode produces a paged summary (§8)", () => {
  const deck = renderReport(usukResults, { mode: "deck" });
  assert.match(deck, /class="[^"]*slide/);
  assert.ok(bytes(deck) < 400 * 1024);
  assert.ok(deck.includes("£248,323.97"), "the deck carries the same figures as the report");
});

// --- narrative (§8): the model may never introduce a number ------------------

test("narrative is rejected if it contains a numeral not in the computed results", () => {
  const good = "Total wealth stands at £248,323.97 across four accounts, with 4 critical flags to address.";
  assert.doesNotThrow(() => validateNarrative(good, usukResults));

  assert.throws(
    () => validateNarrative("Your portfolio grew by 12.7% last quarter to £999,999.00.", usukResults),
    NarrativeRejected,
    "a number the engine never computed must be refused, not rendered"
  );
});

test("narrative validation ignores formatting but catches invented precision", () => {
  // Formatting is irrelevant; a single digit of invented precision is not.
  assert.doesNotThrow(() => validateNarrative("The total is 248,323.97.", usukResults));
  assert.doesNotThrow(() => validateNarrative("The total is £248323.97.", usukResults));
  assert.throws(() => validateNarrative("The total is £248,323.98.", usukResults), NarrativeRejected);
});

test("narrative blocks are clearly attributed when present", () => {
  const html = renderReport(usukResults, {
    narrative: { wealth: "Total wealth stands at £248,323.97." },
  });
  assert.match(html, /class="commentary"/);
  assert.match(html, /AI-generated commentary/i, "the reader must know which words are machine-written");
});
