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

test("the PWA manifest is complete, and no broken service worker ships (§8)", () => {
  assert.match(usukHtml, /rel="manifest"/);
  assert.match(usukHtml, /application\/manifest\+json/);

  const href = usukHtml.match(/rel="manifest" href="data:application\/manifest\+json,([^"]+)"/);
  assert.ok(href, "the manifest must be inline so the file stays self-contained");
  const manifest = JSON.parse(decodeURIComponent(href![1]!));
  assert.ok(manifest.icons?.length, "an installable app needs icons");
  assert.equal(manifest.start_url, "./", "'.' is unresolvable against a data: manifest");
  assert.ok(manifest.name && manifest.theme_color);

  // Chrome rejects blob:/data: service worker scripts outright, so a genuinely
  // single-file report cannot register one. Shipping a registration that always
  // throws would be claiming offline support the report does not have; being
  // self-contained is what actually delivers it.
  assert.equal(/navigator\.serviceWorker\.register/.test(usukHtml), false, "no service worker that cannot work");
  assert.equal(/URL\.createObjectURL/.test(usukHtml), false);
});

test("no table is wider than the phone the report is designed for (§8)", () => {
  // A min-width above the viewport does not "scroll inside its own container"
  // in any useful sense — it puts a PFIC row's severity and value off-screen.
  const tableRules = usukHtml.match(/table\s*\{[^}]*\}/g) ?? [];
  for (const rule of tableRules) {
    const minWidth = rule.match(/min-width:\s*([\d.]+)rem/);
    if (minWidth) {
      assert.ok(Number(minWidth[1]) <= 20, `a table declares min-width ${minWidth[1]}rem, wider than a 390px screen`);
    }
  }
  assert.match(usukHtml, /@media \(max-width: 33\.99rem\)[\s\S]*?\.col-detail\s*\{\s*display:\s*none/, "secondary columns drop on a phone");
  assert.match(usukHtml, /class="col-detail"/, "and something is actually marked as secondary");
});

test("the currency toggle swaps every pair, not just the headline (§8)", () => {
  // The button says "Show in USD"; a reader who presses it must see the report
  // in USD, not one number in USD.
  assert.match(usukHtml, /:root\[data-primary="secondary"\] \.rowpair/, "table pairs must respond to the toggle");
  assert.match(usukHtml, /:root\[data-primary="secondary"\] \.pair/);
  const pairsInTables = (usukHtml.match(/class="rowpair"/g) ?? []).length;
  assert.ok(pairsInTables >= 20, `only ${pairsInTables} dual-currency cells — the signature should be pervasive`);
});

test("every colour used for TEXT meets WCAG AA on the paper ground (§8)", () => {
  const luminance = (hex: string) => {
    const channel = (value: number) => {
      const srgb = value / 255;
      return srgb <= 0.03928 ? srgb / 12.92 : Math.pow((srgb + 0.055) / 1.055, 2.4);
    };
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
    return 0.2126 * channel(r!) + 0.7152 * channel(g!) + 0.0722 * channel(b!);
  };
  const ratio = (a: string, b: string) => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi! + 0.05) / (lo! + 0.05);
  };
  const paper = "#FAFAF7";
  const textColours = {
    ink: "#101B2D",
    inkSoft: "#4A5568",
    brassText: "#6B5C2E",
    alert: "#A3231B",
    ok: "#2E6B4F",
  };
  for (const [name, colour] of Object.entries(textColours)) {
    const contrast = ratio(colour, paper);
    assert.ok(contrast >= 4.5, `${name} (${colour}) is ${contrast.toFixed(2)}:1 on paper — AA needs 4.5:1`);
  }
  // The plain accent is used for bars and rules only, which need 3:1.
  assert.ok(ratio("#8C7A3F", paper) >= 3, "the non-text accent must still meet 3:1");
  // And it must not be used for any text.
  assert.equal(/color: var\(--brass\)/.test(usukHtml), false, "the low-contrast accent must never colour text");
});

test("dual currency is the signature: every headline is a stacked pair (§8)", () => {
  assert.match(usukHtml, /class="pair"/);
  assert.match(usukHtml, /£248,323\.97/);
  assert.match(usukHtml, /\$317,854\.69/);
  // Numbers always carry an explicit currency symbol — never bare.
  assert.equal(/>\s*248,323\.97\s*</.test(usukHtml), false, "a bare number with no currency symbol");
  assert.match(usukHtml, /font-variant-numeric:\s*tabular-nums/);
});

test("the report states what the second currency column actually means (§8)", () => {
  // The base column is struck at each holding's own date; the second is that
  // total converted at one report-date rate. A reader who assumes both were
  // struck on the same day will misread any currency move between them.
  assert.match(usukHtml, /struck in GBP at each holding's own valuation date/);
  assert.match(usukHtml, /GBPUSD 1\.2800 as at 30 June 2026/);
  assert.match(usukHtml, /same wealth measured two ways, not two independent valuations/);
});

test("tables carry header scope for screen readers (§8)", () => {
  // (?=[\s>]) so <thead> is not mistaken for a header cell.
  const headers = usukHtml.match(/<th(?=[\s>])[^>]*>/g) ?? [];
  assert.ok(headers.length > 10);
  for (const header of headers) {
    assert.match(header, /scope="col"/, `a header cell has no scope: ${header}`);
  }
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

test("the treaty caveat leads the US section, before any severity label (§9)", () => {
  const sectionStart = usukHtml.indexOf("What should worry you");
  const caveatAt = usukHtml.indexOf("treaty position is an argument", sectionStart);
  const firstSeverityAt = usukHtml.indexOf("CRITICAL", sectionStart);
  assert.ok(caveatAt > sectionStart, "the caveat must be in the US section");
  assert.ok(
    caveatAt < firstSeverityAt,
    "a reader must meet the treaty caveat BEFORE the first severity label, not after"
  );
  assert.match(usukHtml, /tax lawyer or dual-qualified adviser/);
  assert.match(usukHtml, /has been reviewed by a US-qualified tax adviser|Nothing here has been reviewed/);
});

test("a wrapper position sourced to an analogy is marked contested, not settled (§7.2)", () => {
  // The params say the SIPP treaty position is "an analogy (position, not
  // authority)". That uncertainty existed in the data and was discarded by the
  // renderer, so a contested position rendered as a confident green badge.
  assert.match(usukHtml, /class="sources"/);
  assert.match(usukHtml, /This is a treaty position, not settled authority/);
  const wrapperSection = usukHtml.slice(usukHtml.indexOf("How your wrappers are treated"));
  assert.match(wrapperSection, /Basis:/, "each wrapper cell shows what its position rests on");
});

test("the report declares a CSP that forbids it phoning home (§9)", () => {
  // The report claims to be self-contained. This makes the browser enforce it,
  // so a future edit that tried to transmit would be blocked, not permitted.
  assert.match(usukHtml, /http-equiv="Content-Security-Policy"/);
  assert.match(usukHtml, /connect-src 'none'/);
  assert.match(usukHtml, /default-src 'none'/);
  assert.match(usukHtml, /form-action 'none'/);
  // And no eval, which would let injected script run.
  assert.equal(/unsafe-eval/.test(usukHtml), false);
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

test("--deck is a genuine paged summary, not the report with a class (§8)", () => {
  const deck = renderReport(usukResults, { mode: "deck" });
  assert.match(deck, /class="slide"/);
  assert.ok(bytes(deck) < 400 * 1024);
  assert.ok(deck.includes("£248,323.97"), "the deck carries the same figures as the report");

  // Each slide must fit one screen, so it cannot contain the long tables.
  assert.match(deck, /\.slide\s*\{[^}]*max-height:\s*100svh/);
  const deckTables = (deck.match(/<table/g) ?? []).length;
  const reportTables = (usukHtml.match(/<table/g) ?? []).length;
  assert.ok(deckTables < reportTables / 2, `deck has ${deckTables} tables against the report's ${reportTables}`);
  assert.ok(!deck.includes("Where every figure came from</p>\n<h2>Data appendix"), "the full appendix belongs in the report");

  // A screen-share artifact that cannot show the second currency defeats the
  // point of a dual-currency product.
  assert.match(deck, /id="currency-toggle"/);

  // Consumer Duty: the deck is the document actually used in the meeting.
  // Dropping the limitations while keeping "4 critical flags" is a
  // fair-clear-and-not-misleading failure in the highest-traffic artefact.
  // Compare against the escaped form the renderer emits.
  const escaped = (text: string) =>
    text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  for (const warning of usukResults.warnings) {
    assert.ok(
      deck.includes(escaped(warning)),
      `the deck drops a caveat the report carries: "${warning.slice(0, 60)}…"`
    );
  }
  assert.ok(deck.includes(escaped(usukResults.disclaimer)), "the deck must carry the disclaimer");
  assert.match(deck, /contested readings of the UK\/US treaty/, "and the treaty caveat");
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
