// Mobile-first client report (SPEC §8). One self-contained HTML file: inline
// CSS and JS, no CDN, no build step, installable as a PWA and readable offline.
//
// Structure encodes meaning: the sections are ordered by the questions a client
// actually asks, not by how the system is built.
import { styles } from "./styles.ts";
import { barChart, dragChart, pairedBars, stackedBar } from "./charts.ts";
import { bps, esc, freshness, longDate, money, moneyShort, percent, wrapperLabel } from "./format.ts";
import type { NarrativeSections } from "./narrative.ts";
import type { Results } from "../cli/results.ts";
import type { DualMoney, Slice } from "../engine/consolidate.ts";

export interface RenderOptions {
  mode?: "report" | "deck";
  narrative?: NarrativeSections;
  /** Household display name; defaults to the redaction-safe token. */
  title?: string;
}

const SECTIONS = {
  wealth: "What you have",
  cost: "What it costs",
  performance: "How it has done",
  exposure: "What you are exposed to",
  usConnect: "What should worry you",
  appendix: "Where every figure came from",
} as const;

/**
 * The two columns are not the same measurement, and saying so matters. Each
 * base figure is struck at its own holding's valuation date; the second
 * currency is that base figure converted at one rate as at the report date. A
 * reader who assumes both were struck on the same day will misread any
 * currency move between the two.
 */
function currencyBasisNote(results: Results): string {
  const rate = results.meta.secondary_rate;
  if (!rate || !results.meta.secondary_currency) return "";
  return (
    `<p class="asof small">Figures are struck in ${esc(results.meta.base_currency)} at each holding's own valuation date, ` +
    `then shown in ${esc(results.meta.secondary_currency)} at ${esc(rate.pair)} ${rate.rate.toFixed(4)} as at ${esc(longDate(rate.date))}. ` +
    `The two columns are the same wealth measured two ways, not two independent valuations.</p>`
  );
}

/** The stacked GBP/USD pair — the product's signature element. */
function pair(value: DualMoney): string {
  if (!value.secondary) {
    return `<div class="pair"><div class="primary">${esc(money(value.base))}</div></div>`;
  }
  return (
    `<div class="pair">` +
    `<div class="primary">${esc(money(value.base))}</div>` +
    `<div class="divider" aria-hidden="true"></div>` +
    `<div class="secondary">${esc(money(value.secondary))}</div>` +
    `</div>`
  );
}

/**
 * Builds a pair from a scalar base amount using the single rate the engine
 * recorded for this report. The signature of the product is that every figure
 * is legible in both currencies — a toggle that moves one number is a toggle
 * that lies.
 */
function dualFromBase(amount: number, results: Results): DualMoney {
  const base = { amount: Math.round(amount * 100) / 100, currency: results.meta.base_currency };
  const rate = results.meta.secondary_rate;
  if (!rate || !results.meta.secondary_currency) return { base };
  return {
    base,
    secondary: {
      amount: Math.round(amount * rate.rate * 100) / 100,
      currency: results.meta.secondary_currency,
    },
  };
}

/** Inline row form of the same idea, for tables. */
function rowPair(value: DualMoney): string {
  return (
    `<span class="rowpair"><span class="a">${esc(money(value.base))}</span>` +
    (value.secondary ? `<span class="b">${esc(money(value.secondary))}</span>` : "") +
    `</span>`
  );
}

function commentary(text: string | undefined): string {
  if (!text) return "";
  return (
    `<aside class="commentary">` +
    `<p class="byline">AI-generated commentary</p>` +
    `<p>${esc(text)}</p>` +
    `</aside>`
  );
}

function sliceTable(slices: Slice[], heading: string, limit = 100): string {
  const rows = slices
    .slice(0, limit)
    .map(
      (slice) =>
        `<tr><td>${esc(slice.label)}</td><td class="r num">${percent(slice.shareOfTotal)}</td>` +
        `<td class="r num">${rowPair(slice.value)}</td></tr>`
    )
    .join("");
  return (
    `<div class="scroll" role="region" aria-label="${esc(heading)}" tabindex="0">` +
    `<table><thead><tr><th scope="col">${esc(heading)}</th><th scope="col" class="r">Share</th><th scope="col" class="r">Value</th></tr></thead>` +
    `<tbody>${rows}</tbody></table></div>`
  );
}

function wealthSection(results: Results, options: RenderOptions): string {
  const { consolidation } = results;
  const freshnessRows = consolidation.byAccount
    .map((slice) => {
      const asof = (results.appendix.accountFreshness ?? {})[slice.key];
      return (
        `<tr><td>${esc(slice.label)}</td>` +
        `<td class="num">${asof ? esc(longDate(asof)) : "—"}</td>` +
        `<td class="num small muted">${asof ? esc(freshness(asof, results.meta.asof)) : ""}</td>` +
        `<td class="r num">${rowPair(slice.value)}</td></tr>`
      );
    })
    .join("");

  return `<section id="wealth"${options.mode === "deck" ? ' class="slide"' : ""}>
<p class="eyebrow">${esc(SECTIONS.wealth)}</p>
<h2>Total wealth</h2>
${pair(consolidation.total)}
<p class="asof">as at ${esc(longDate(results.meta.asof))}</p>
${commentary(options.narrative?.wealth)}
<h3>By account, and how fresh each figure is</h3>
<div class="scroll" role="region" aria-label="Accounts" tabindex="0">
<table><thead><tr><th scope="col">Account</th><th scope="col">Valued</th><th scope="col">Age</th><th scope="col" class="r">Value</th></tr></thead>
<tbody>${freshnessRows}</tbody></table></div>
<h3>By wrapper</h3>
${barChart(
  consolidation.byWrapper.map((slice) => ({ label: wrapperLabel(slice.label), value: slice.value.base.amount })),
  { title: "Total wealth by wrapper", formatValue: (v) => moneyShort({ amount: v, currency: consolidation.total.base.currency }) }
)}
</section>`;
}

function costSection(results: Results, options: RenderOptions): string {
  const { costStack, compoundingDrag } = results;
  const categories = Object.entries(costStack.byCategory).map(([key, total]) => ({
    label: key.replace(/_/g, " "),
    value: total.amount.amount,
  }));
  const currency = costStack.total.amount.currency;

  const lines = costStack.lines
    .map(
      (line) =>
        `<tr><td>${esc(line.label)}<span class="small muted"> · ${esc(line.accountToken ?? "")}</span></td>` +
        `<td>${esc((line.category ?? "other").replace(/_/g, " "))}</td>` +
        `<td class="r num">${rowPair(dualFromBase(line.amount.amount, results))}</td>` +
        `<td class="small muted mono col-detail">${esc(line.sourceDocument ?? "")}</td></tr>`
    )
    .join("");

  return `<section id="cost"${options.mode === "deck" ? ' class="slide"' : ""}>
<p class="eyebrow">${esc(SECTIONS.cost)}</p>
<h2>Cost of ownership</h2>
${pair(dualFromBase(costStack.total.amount.amount, results))}
<p class="asof">${esc(bps(costStack.total.bps))} a year · charges disclosed for the year to ${esc(longDate(costStack.period.to))}</p>
${commentary(options.narrative?.cost)}
${stackedBar(categories, { title: "Cost by category", formatValue: (v) => money({ amount: v, currency }) })}
<h3>What ${esc(bps(costStack.total.bps))} compounds to over ${compoundingDrag.years} years</h3>
${dragChart({
  title: `Growth before and after costs over ${compoundingDrag.years} years`,
  years: compoundingDrag.years,
  // Taken from the projection itself. Re-deriving these from literals is how a
  // chart comes to contradict the sentence printed directly beneath it.
  startingValue: compoundingDrag.startingValue.amount,
  grossRate: compoundingDrag.grossGrowthRate,
  netRate: compoundingDrag.grossGrowthRate - compoundingDrag.annualFeeRate,
  formatValue: (v) => moneyShort({ amount: v, currency }),
})}
<p class="small muted">Before costs ${esc(money(compoundingDrag.grossTerminal, 0))} · after costs ${esc(money(compoundingDrag.netTerminal, 0))} · the difference is ${esc(money(compoundingDrag.drag, 0))}. Assumes ${esc(compoundingDrag.assumption)}.</p>
<h3>Every charge, and the document it came from</h3>
<div class="scroll" role="region" aria-label="Charges" tabindex="0">
<table><thead><tr><th scope="col">Charge</th><th scope="col">Category</th><th scope="col" class="r">Amount</th><th scope="col" class="col-detail">Source</th></tr></thead>
<tbody>${lines || `<tr><td colspan="4" class="muted">No charges disclosed for this period.</td></tr>`}</tbody></table></div>
</section>`;
}

function performanceSection(results: Results, options: RenderOptions): string {
  const { performance } = results;
  const portfolio = performance.portfolio;
  const method = portfolio?.method === "twr" ? "Time-weighted return" : "Modified Dietz";
  const estimate = portfolio?.isEstimate ? " · estimate" : "";

  const accountRows = performance.perAccount
    .map(
      (entry) =>
        `<tr><td>${esc(entry.accountToken)}</td><td class="num">${esc(percent(entry.return.return))}</td>` +
        `<td class="small muted">${esc(entry.return.method === "twr" ? "TWR" : "Dietz estimate")}</td></tr>`
    )
    .join("");

  const benchmark = performance.benchmark
    ? `<h3>Against your benchmark</h3>
<div class="scroll" role="region" aria-label="Benchmark comparison" tabindex="0">
<table><thead><tr><th scope="col"><span class="visually-hidden">Measure</span></th><th scope="col" class="r">Nominal</th><th scope="col" class="r">After inflation</th></tr></thead>
<tbody>
<tr><td>Your portfolio</td><td class="r num">${esc(percent(performance.benchmark.portfolio.nominal))}</td><td class="r num">${esc(percent(performance.benchmark.portfolio.real))}</td></tr>
<tr><td>Benchmark</td><td class="r num">${esc(percent(performance.benchmark.benchmark.nominal))}</td><td class="r num">${esc(percent(performance.benchmark.benchmark.real))}</td></tr>
<tr class="total"><td>Difference</td><td class="r num">${esc(percent(performance.benchmark.excessNominal))}</td><td class="r num">—</td></tr>
</tbody></table></div>
<p class="small muted">${esc(performance.benchmark.benchmark.assumption)}</p>`
    : "";

  return `<section id="performance"${options.mode === "deck" ? ' class="slide"' : ""}>
<p class="eyebrow">${esc(SECTIONS.performance)}</p>
<h2>Performance</h2>
${
  portfolio
    ? `<p class="pair"><span class="primary">${esc(percent(portfolio.return))}</span></p>
<p class="asof">${esc(method)}${esc(estimate)} · ${esc(longDate(performance.from))} to ${esc(longDate(performance.to))}</p>
<p class="small muted">${esc(portfolio.assumption)}</p>`
    : `<p class="muted">Not enough accepted valuation dates to measure a return yet.</p>`
}
${commentary(options.narrative?.performance)}
${benchmark}
${accountRows ? `<h3>By account</h3><div class="scroll" role="region" aria-label="Performance by account" tabindex="0"><table><thead><tr><th scope="col">Account</th><th scope="col">Return</th><th scope="col">Method</th></tr></thead><tbody>${accountRows}</tbody></table></div>` : ""}
</section>`;
}

function exposureSection(results: Results, options: RenderOptions): string {
  const { risk, consolidation } = results;
  const currency = consolidation.total.base.currency;

  const flags = risk.singleIssuerFlags
    .map(
      (flag) =>
        `<tr><td>${esc(flag.label)}</td><td class="r num">${esc(percent(flag.share))}</td>` +
        `<td class="r num">${rowPair(dualFromBase(flag.amount, results))}</td></tr>`
    )
    .join("");

  return `<section id="exposure"${options.mode === "deck" ? ' class="slide"' : ""}>
<p class="eyebrow">${esc(SECTIONS.exposure)}</p>
<h2>Exposure and concentration</h2>
${commentary(options.narrative?.exposure)}
<h3>By asset class</h3>
${barChart(
  risk.assetSplit.map((slice) => ({ label: slice.label, value: slice.value.base.amount })),
  { title: "Wealth by asset class", formatValue: (v) => moneyShort({ amount: v, currency }) }
)}
<h3>Ten largest positions</h3>
${sliceTable(risk.topPositions, "Position", 10)}
${
  flags
    ? `<h3>Positions above 5% of total wealth</h3>
<div class="scroll" role="region" aria-label="Concentration flags" tabindex="0">
<table><thead><tr><th scope="col">Position</th><th scope="col" class="r">Share</th><th scope="col" class="r">Value</th></tr></thead><tbody>${flags}</tbody></table></div>`
    : `<p class="muted">No single position exceeds 5% of total wealth.</p>`
}
<h3>Currency exposure</h3>
${sliceTable(consolidation.byCurrency, "Currency")}
<h3>Wrapped versus unwrapped</h3>
<div class="scroll" role="region" aria-label="Wrapped versus unwrapped" tabindex="0">
<table><thead><tr><th scope="col">Jurisdiction</th><th scope="col" class="r">Sheltered</th><th scope="col" class="r">Exposed</th></tr></thead><tbody>
${Object.entries(risk.wrappedRatioByJurisdiction)
  .map(
    ([jurisdiction, split]) =>
      `<tr><td>${esc(jurisdiction)}</td><td class="r num">${rowPair(dualFromBase(split.wrapped, results))}</td>` +
      `<td class="r num">${rowPair(dualFromBase(split.unwrapped, results))}</td></tr>`
  )
  .join("")}
</tbody></table></div>
</section>`;
}

function usConnectSection(results: Results, options: RenderOptions): string {
  const usConnect = results.usConnect as any;
  if (!usConnect) return ""; // §7: silently absent, not an empty section.

  const severityChip = (severity: string) =>
    `<span class="chip ${severity === "CRITICAL" ? "chip-critical" : severity === "OK" ? "chip-ok" : "chip-warn"}">${esc(severity)}</span>`;

  const pficRows = (usConnect.pfic?.holdings ?? [])
    .filter((holding: any) => holding.outcome !== "not_pfic")
    .map(
      (holding: any) =>
        `<tr${holding.severity === "CRITICAL" ? ' class="critical-row"' : ""}>` +
        `<td>${esc(holding.instrumentName)}<span class="small muted"> · ${esc(holding.accountToken)} ${esc(wrapperLabel(holding.wrapper))}</span></td>` +
        `<td>${severityChip(holding.severity)}</td>` +
        `<td class="r num">${rowPair(dualFromBase(holding.valueBase, results))}</td></tr>`
    )
    .join("");

  const wrapperRows = (usConnect.wrapperConflicts ?? [])
    .map(
      (conflict: any) =>
        `<tr><td>${esc(wrapperLabel(conflict.wrapper))}</td><td>${severityChip(conflict.severity)}</td>` +
        `<td class="small">${esc(conflict.explanation)}</td></tr>`
    )
    .join("");

  const situsRows = (usConnect.situs?.persons ?? [])
    .map(
      (person: any) =>
        `<tr><td>${esc(person.personToken)}</td>` +
        `<td class="r num">${rowPair(dualFromBase(person.usSitus?.totalBase ?? 0, results))}</td>` +
        `<td class="r num">${rowPair(dualFromBase(person.nonUsSitus?.totalBase ?? 0, results))}</td>` +
        `<td class="r num">${rowPair(dualFromBase(person.unclassified?.totalBase ?? 0, results))}</td></tr>`
    )
    .join("");

  return `<section id="us-connected"${options.mode === "deck" ? ' class="slide"' : ""}>
<p class="eyebrow">${esc(SECTIONS.usConnect)}</p>
<h2>US-connected exposure</h2>
<p class="flag-count num">${esc(usConnect.criticalCount)}</p>
<p>critical ${usConnect.criticalCount === 1 ? "flag" : "flags"} to address.</p>
${commentary(options.narrative?.usConnect)}
${
  pficRows
    ? `<h3>Passive foreign investment companies</h3>
<div class="scroll" role="region" aria-label="PFIC holdings" tabindex="0">
<table><thead><tr><th scope="col">Holding</th><th scope="col">Severity</th><th scope="col" class="r">Value</th></tr></thead><tbody>${pficRows}</tbody></table></div>
<p class="small muted">${esc(usConnect.pfic?.filingImplication ?? "Form 8621 may be required for each PFIC holding, for each year it is held.")}</p>`
    : ""
}
${
  wrapperRows
    ? `<h3>How your wrappers are treated</h3>
<div class="scroll" role="region" aria-label="Wrapper treatment" tabindex="0">
<table><thead><tr><th scope="col">Wrapper</th><th scope="col">Status</th><th scope="col">Why</th></tr></thead><tbody>${wrapperRows}</tbody></table></div>`
    : ""
}
${currencyOfLifeBlock(usConnect)}
${
  situsRows
    ? `<h3>Estate exposure sketch — not advice</h3>
<div class="scroll" role="region" aria-label="Situs exposure" tabindex="0">
<table><thead><tr><th scope="col">Person</th><th scope="col" class="r">US situs</th><th scope="col" class="r">Non-US situs</th><th scope="col" class="r">Unclassified</th></tr></thead><tbody>${situsRows}</tbody></table></div>
<p class="small muted">${esc(usConnect.situs?.treatyCredit?.note ?? "")}</p>`
    : ""
}
</section>`;
}

/**
 * §7.4: the currencies the portfolio is exposed to against the currencies the
 * client actually spends in. Only rendered once an operator has recorded a
 * spending mix — without one there is nothing to compare against, and an
 * invented default would be worse than an absent section.
 */
function currencyOfLifeBlock(usConnect: any): string {
  const people = (usConnect.currencyOfLife?.persons ?? []).filter((person: any) => person.spendingMix);
  if (!people.length) return "";

  return people
    .map((person: any) => {
      const rows = (person.rows ?? []).map((row: any) => ({
        label: row.currency,
        a: row.portfolioShare ?? person.portfolioMix?.[row.currency] ?? 0,
        b: row.spendingShare ?? person.spendingMix?.[row.currency] ?? 0,
      }));
      const score = typeof person.mismatchScore === "number" ? percent(person.mismatchScore) : null;
      return (
        `<h3>The currencies you hold, against the currencies you spend</h3>` +
        pairedBars(rows, {
          title: `Currency exposure versus spending for ${person.personToken}`,
          aLabel: "held",
          bLabel: "spent",
        }) +
        (score ? `<p class="small muted">Mismatch score ${esc(score)}. ${esc(usConnect.currencyOfLife?.lookThroughNote ?? "")}</p>` : "")
      );
    })
    .join("");
}

function appendixSection(results: Results, options: RenderOptions): string {
  const rows = results.appendix.documents
    .map(
      (document) =>
        `<tr><td>${esc(document.filename)}<span class="small muted"> · ${esc(document.institution)}</span></td>` +
        `<td class="small">${esc(document.doc_type.replace(/_/g, " "))}</td>` +
        `<td class="small num col-detail">${esc(document.period.from)} → ${esc(document.period.to)}</td>` +
        `<td class="small num">${document.parsed_at ? esc(document.parsed_at.slice(0, 10)) : "—"}</td>` +
        `<td class="small mono col-detail">${esc(document.sha256.slice(0, 12))}</td></tr>`
    )
    .join("");

  const warnings = results.warnings.map((warning) => `<li>${esc(warning)}</li>`).join("");

  return `<section id="appendix"${options.mode === "deck" ? ' class="slide"' : ""}>
<p class="eyebrow">${esc(SECTIONS.appendix)}</p>
<h2>Data appendix</h2>
<p class="small muted">Every figure in this report comes from one of the documents below. Nothing was estimated or filled in.</p>
<div class="scroll" role="region" aria-label="Source documents" tabindex="0">
<table><thead><tr><th scope="col">Document</th><th scope="col">Type</th><th scope="col" class="col-detail">Period</th><th scope="col">Parsed</th><th scope="col" class="col-detail">Fingerprint</th></tr></thead>
<tbody>${rows}</tbody></table></div>
${
  results.appendix.instrumentsNeedingConfirmation.length
    ? `<h3>Awaiting classification</h3><p class="small">These holdings have not had their type and domicile confirmed, so they are excluded from the tax analysis rather than assumed safe: ${esc(results.appendix.instrumentsNeedingConfirmation.join(", "))}.</p>`
    : ""
}
${warnings ? `<h3>What to read carefully</h3><ul class="warnings">${warnings}</ul>` : ""}
</section>`;
}

/** Inlined PWA plumbing — no external files, works when opened from disk. */
/** A brass "M" on paper, inline so the manifest needs no external file. */
const ICON_SVG =
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">` +
  `<rect width="64" height="64" fill="#101B2D"/>` +
  `<text x="32" y="45" font-family="Georgia,serif" font-size="38" fill="#C4B587" text-anchor="middle">M</text></svg>`;

export function manifestLink(title: string): string {
  const icon = `data:image/svg+xml,${encodeURIComponent(ICON_SVG)}`;
  const manifest = {
    name: title,
    short_name: "Meridian",
    display: "standalone",
    background_color: "#FAFAF7",
    theme_color: "#101B2D",
    // Resolved against the document, not the data: manifest — "." would be
    // unresolvable from a data URL.
    start_url: "./",
    icons: [
      { src: icon, sizes: "any", type: "image/svg+xml", purpose: "any" },
      { src: icon, sizes: "any", type: "image/svg+xml", purpose: "maskable" },
    ],
  };
  return `<link rel="manifest" href="data:application/manifest+json,${encodeURIComponent(JSON.stringify(manifest))}">`;
}

const CURRENCY_TOGGLE = `<script>
(function () {
  var button = document.getElementById("currency-toggle");
  if (!button) return;
  button.addEventListener("click", function () {
    var swapped = document.documentElement.getAttribute("data-primary") === "secondary";
    document.documentElement.setAttribute("data-primary", swapped ? "primary" : "secondary");
    button.setAttribute("aria-pressed", swapped ? "false" : "true");
    button.textContent = swapped ? button.dataset.a : button.dataset.b;
  });
})();
</script>`;

/**
 * §8 `--deck`: "a paged summary for screen-sharing". A deck is not the report
 * with a class on it — a 2,685px "slide" containing a twelve-row table is
 * unusable on a shared screen. Each slide carries one idea and fits one view.
 */
function deckSlides(results: Results): string {
  const { consolidation, costStack, performance, risk } = results;
  const usConnect = results.usConnect as any;
  const currency = consolidation.total.base.currency;

  const slide = (eyebrow: string, body: string) =>
    `<section class="slide"><p class="eyebrow">${esc(eyebrow)}</p>${body}</section>`;

  const topPositions = risk.topPositions
    .slice(0, 5)
    .map(
      (position) =>
        `<tr><td>${esc(position.label)}</td><td class="r num">${esc(percent(position.shareOfTotal))}</td>` +
        `<td class="r num">${rowPair(position.value)}</td></tr>`
    )
    .join("");

  const criticalRows = ((usConnect?.pfic?.holdings ?? []) as any[])
    .filter((holding) => holding.severity === "CRITICAL")
    .slice(0, 6)
    .map(
      (holding) =>
        `<tr class="critical-row"><td>${esc(holding.instrumentName)}` +
        `<span class="small muted"> · ${esc(wrapperLabel(holding.wrapper))}</span></td>` +
        `<td class="r num">${esc(money({ amount: holding.valueBase, currency }))}</td></tr>`
    )
    .join("");

  return [
    slide(SECTIONS.wealth, `<h2>Total wealth</h2>${pair(consolidation.total)}<p class="asof">as at ${esc(longDate(results.meta.asof))}</p>`),
    slide(
      SECTIONS.cost,
      `<h2>What it costs</h2>${pair(dualFromBase(costStack.total.amount.amount, results))}` +
        `<p class="asof">${esc(bps(costStack.total.bps))} a year · year to ${esc(longDate(costStack.period.to))}</p>` +
        `<p class="small muted">Over ${results.compoundingDrag.years} years that is ${esc(money(results.compoundingDrag.drag, 0))} of growth foregone.</p>`
    ),
    slide(
      SECTIONS.performance,
      performance.portfolio
        ? `<h2>How it has done</h2><p class="pair"><span class="primary">${esc(percent(performance.portfolio.return))}</span></p>` +
            `<p class="asof">${esc(performance.portfolio.method === "twr" ? "Time-weighted" : "Modified Dietz")}` +
            `${performance.portfolio.isEstimate ? " · estimate" : ""} · ${esc(longDate(performance.from))} to ${esc(longDate(performance.to))}</p>`
        : `<h2>How it has done</h2><p class="muted">Not enough accepted valuation dates to measure a return yet.</p>`
    ),
    slide(
      SECTIONS.exposure,
      `<h2>Five largest positions</h2><div class="scroll" role="region" aria-label="Largest positions" tabindex="0">` +
        `<table><thead><tr><th scope="col">Position</th><th scope="col" class="r">Share</th><th scope="col" class="r">Value</th></tr></thead><tbody>${topPositions}</tbody></table></div>`
    ),
    usConnect
      ? slide(
          SECTIONS.usConnect,
          `<h2>US-connected exposure</h2><p class="flag-count num">${esc(usConnect.criticalCount)}</p>` +
            `<p>critical ${usConnect.criticalCount === 1 ? "flag" : "flags"} to address.</p>` +
            (criticalRows
              ? `<div class="scroll" role="region" aria-label="Critical holdings" tabindex="0">` +
                `<table><thead><tr><th scope="col">Holding</th><th scope="col" class="r">Value</th></tr></thead><tbody>${criticalRows}</tbody></table></div>`
              : "")
        )
      : "",
    slide(
      SECTIONS.appendix,
      `<h2>Where every figure came from</h2><p>${esc(results.appendix.documents.length)} source documents, ` +
        `each fingerprinted and dated. The full appendix is in the written report.</p>`
    ),
  ].join("\n");
}

export function renderReport(results: Results, options: RenderOptions = {}): string {
  const hasAlert = Boolean((results.usConnect as any)?.criticalCount);
  const deck = options.mode === "deck";
  const title = options.title ?? `Wealth report · ${longDate(results.meta.asof)}`;
  const base = results.consolidation.total.base.currency;
  const secondary = results.consolidation.total.secondary?.currency;

  const toggle =
    secondary
      ? `<button id="currency-toggle" class="no-print" type="button" aria-pressed="false" data-a="Show in ${esc(secondary)}" data-b="Show in ${esc(base)}">Show in ${esc(secondary)}</button>`
      : "";

  return `<!doctype html>
<html lang="en" data-primary="primary">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<meta name="theme-color" content="#101B2D">
<title>${esc(title)}</title>
${manifestLink(title)}
<style>${styles({ hasAlert, deck })}</style>
</head>
<body>
<main>
<header${deck ? ' class="slide"' : ""}>
  <div class="masthead">
    <div>
      <p class="eyebrow">Meridian</p>
      <h1>${esc(title)}</h1>
    </div>
    ${toggle}
  </div>
  <p class="asof">Two currencies, one truth. Prepared ${esc(longDate(results.meta.generated_at.slice(0, 10)))}.</p>
  ${currencyBasisNote(results)}
</header>
${
  deck
    ? deckSlides(results)
    : [
        wealthSection(results, options),
        costSection(results, options),
        performanceSection(results, options),
        exposureSection(results, options),
        usConnectSection(results, options),
        appendixSection(results, options),
      ].join("\n")
}
<footer>
  <p>${esc(results.disclaimer)}</p>
  <p class="small">Household ${esc(results.meta.household_id)} · generated ${esc(results.meta.generated_at)}</p>
</footer>
</main>
${CURRENCY_TOGGLE}
</body>
</html>
`;
}
