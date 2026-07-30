// The report's design system (SPEC §8).
//
// The identity is "two currencies, one truth": every headline value is a
// stacked pair separated by a fine vertical rule, like a banker's ledger, and
// the currency toggle swaps which of the two is primary rather than hiding one.
//
// Palette is deep ink navy on paper white with a single restrained brass
// accent. Alert red is RESERVED for PFIC/CRITICAL and is emitted only when the
// household actually has such a flag — §8's acceptance criterion is that a
// PFIC-free household shows no red anywhere, which a palette token sitting
// unused in the stylesheet would violate.
//
// Fonts are system stacks: the CSP forbids remote fonts, and a silent fallback
// is worse than a deliberate stack. Both families are chosen for old-style /
// lining figures respectively.

const DISPLAY_SERIF = `"Iowan Old Style", "Palatino Linotype", Palatino, "Hoefler Text", Georgia, serif`;
const BODY_SANS = `Seravek, "Gill Sans Nova", "Gill Sans", Ubuntu, Calibri, "Segoe UI", system-ui, sans-serif`;
const MONO = `ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, monospace`;

export function styles(options: { hasAlert: boolean; deck: boolean }): string {
  const alertTokens = options.hasAlert
    ? `
    --alert: #A3231B;
    --alert-wash: #F6E9E7;`
    : "";

  return `
:root {
  --paper: #FAFAF7;
  --paper-sunk: #F2F1EA;
  --ink: #101B2D;
  --ink-soft: #4A5568;
  --brass: #8C7A3F;          /* non-text only: bars, swatches, rules (>=3:1) */
  --brass-text: #6B5C2E;     /* 5.6:1 on paper — the accent wherever it is TEXT */
  --brass-soft: #C4B587;
  --rule: #DEDCD2;
  --rule-strong: #B4B0A2;
  --ok: #2E6B4F;${alertTokens}
  --measure: 34rem;
}

*, *::before, *::after { box-sizing: border-box; }

html { -webkit-text-size-adjust: 100%; }

body {
  margin: 0;
  /* §8: horizontal scroll is forbidden on the page; wide content scrolls
     inside its own container instead. */
  overflow-x: hidden;
  background: var(--paper);
  color: var(--ink);
  font-family: ${BODY_SANS};
  font-size: 17px;
  line-height: 1.55;
  -webkit-font-smoothing: antialiased;
  font-variant-numeric: lining-nums;
}

main { max-width: 46rem; margin: 0 auto; padding: 1.25rem 1.15rem 4rem; }

.num, table, .pair, .c-value, .figure { font-variant-numeric: tabular-nums lining-nums; }

h1, h2, h3 { font-family: ${DISPLAY_SERIF}; font-weight: 500; text-wrap: balance; }
h1 { font-size: 1.5rem; margin: 0 0 0.15rem; letter-spacing: 0.01em; }
h2 { font-size: 1.35rem; margin: 0 0 0.2rem; }
h3 { font-size: 1.02rem; margin: 1.4rem 0 0.35rem; }
p { max-width: var(--measure); margin: 0.55rem 0; }
.muted { color: var(--ink-soft); }
.small { font-size: 0.82rem; }
.eyebrow {
  font-size: 0.68rem; letter-spacing: 0.16em; text-transform: uppercase;
  color: var(--brass-text); font-weight: 600; margin: 0 0 0.35rem;
}

/* --- masthead ------------------------------------------------------------ */
header { border-bottom: 1px solid var(--rule-strong); padding-bottom: 1.1rem; }
.masthead { display: flex; justify-content: space-between; align-items: baseline; gap: 1rem; flex-wrap: wrap; }
.asof { font-size: 0.8rem; color: var(--ink-soft); }

/* --- the dual-currency pair: the signature element ------------------------ */
.pair { display: flex; align-items: stretch; gap: 1rem; }
.pair .divider { width: 1px; background: var(--rule-strong); flex: none; }
.pair .primary {
  font-family: ${DISPLAY_SERIF};
  font-size: clamp(2.1rem, 8.5vw, 3.1rem);
  line-height: 1.02;
  transition: font-size 240ms ease, color 240ms ease;
}
.pair .secondary {
  font-family: ${DISPLAY_SERIF};
  font-size: clamp(1.1rem, 4vw, 1.45rem);
  color: var(--ink-soft);
  align-self: flex-end;
  padding-bottom: 0.28em;
  transition: font-size 240ms ease, color 240ms ease;
}
/* The toggle swaps primacy; neither currency is ever hidden. */
:root[data-primary="secondary"] .pair .primary {
  font-size: clamp(1.1rem, 4vw, 1.45rem); color: var(--ink-soft);
  align-self: flex-end; padding-bottom: 0.28em;
}
:root[data-primary="secondary"] .pair .secondary {
  font-size: clamp(2.1rem, 8.5vw, 3.1rem); color: var(--ink);
  align-self: auto; padding-bottom: 0;
}
:root[data-primary="secondary"] .pair { flex-direction: row-reverse; justify-content: flex-end; }

.rowpair { display: flex; gap: 0.5rem; align-items: baseline; justify-content: flex-end; flex-wrap: wrap; }
.rowpair .a { transition: color 240ms ease; }
.rowpair .b { color: var(--ink-soft); font-size: 0.86em; transition: color 240ms ease, font-size 240ms ease; }
/* The toggle swaps which currency is primary everywhere a pair appears. */
:root[data-primary="secondary"] .rowpair { flex-direction: row-reverse; }
:root[data-primary="secondary"] .rowpair .a { color: var(--ink-soft); font-size: 0.86em; }
:root[data-primary="secondary"] .rowpair .b { color: var(--ink); font-size: 1em; }

/* --- controls ------------------------------------------------------------ */
button {
  font: inherit; font-size: 0.85rem; color: var(--ink); background: var(--paper);
  border: 1px solid var(--rule-strong); border-radius: 2px;
  min-height: 44px; padding: 0 0.9rem; cursor: pointer;
}
button[aria-pressed="true"] { border-color: var(--brass-text); color: var(--brass-text); }
:focus-visible { outline: 2px solid var(--brass); outline-offset: 2px; }

/* --- sections ------------------------------------------------------------ */
section { border-top: 1px solid var(--rule); margin-top: 2.4rem; padding-top: 1.5rem; }
section:first-of-type { border-top: none; }

.card { border: 1px solid var(--rule); padding: 0.85rem 0.95rem; margin: 0.6rem 0; }
.grid { display: grid; grid-template-columns: 1fr; gap: 0.6rem; }

/* --- tables ---------------------------------------------------------------
   A minimum width wider than the target device does not "scroll inside its own
   container" in any useful sense — it puts the severity and the value of a
   PFIC row off the right-hand edge of the phone the report is designed for.
   Tables fit the viewport; genuinely secondary columns are dropped below 34rem
   and restored on wider screens and in print. */
.scroll { overflow-x: auto; border: 1px solid var(--rule); }
table { border-collapse: collapse; width: 100%; font-size: 0.86rem; table-layout: auto; }
th, td { text-align: left; padding: 0.5rem 0.55rem; border-bottom: 1px solid var(--rule); vertical-align: top; overflow-wrap: anywhere; }
@media (max-width: 33.99rem) {
  th, td { padding: 0.45rem 0.4rem; font-size: 0.98em; }
  .col-detail { display: none; }
}
@media (min-width: 34rem) { th, td { padding: 0.5rem 0.7rem; } }
th { font-size: 0.66rem; letter-spacing: 0.12em; text-transform: uppercase; color: var(--ink-soft); font-weight: 600; }
td.r, th.r { text-align: right; }
tr:last-child td { border-bottom: none; }
tr.total td { border-top: 1px solid var(--rule-strong); font-weight: 600; }

/* --- charts ---------------------------------------------------------------
   Chart TEXT is HTML, so it never scales with the container the way SVG text
   does; the SVG carries geometry only and is given an explicit CSS height. */
svg { display: block; max-width: 100%; }
figure.chart { margin: 0.7rem 0 0; }
.bars { list-style: none; margin: 0; padding: 0; }
.bars li { padding: 0.35rem 0; }
.bars .l { font-size: 0.86rem; }
.bars .v { font-size: 0.86rem; color: var(--ink-soft); float: right; }
.bars .bar { height: 9px; width: 100%; clear: both; }
.bars .bar-pair { height: 14px; }
.band { height: 14px; width: 100%; }
.drag { height: 150px; width: 100%; }
.visually-hidden {
  position: absolute; width: 1px; height: 1px; margin: -1px;
  clip-path: inset(50%); overflow: hidden; white-space: nowrap;
}
.c-track { fill: var(--paper-sunk); }
.c-gap { fill: var(--brass); opacity: 0.16; }
.c-line-gross { stroke: var(--ink); stroke-width: 1.5px; }
.c-line-net { stroke: var(--brass); stroke-width: 1.5px; stroke-dasharray: 4 3; }
.legend { list-style: none; margin: 0.6rem 0 0; padding: 0; font-size: 0.82rem; }
.legend li { display: flex; align-items: center; gap: 0.45rem; padding: 0.12rem 0; }
.legend .num { margin-left: auto; color: var(--ink-soft); }
.swatch { width: 0.7rem; height: 0.7rem; flex: none; }

/* --- flags --------------------------------------------------------------- */
.chip {
  display: inline-flex; align-items: center; min-height: 24px;
  border: 1px solid var(--rule-strong); border-radius: 999px;
  padding: 0 0.6rem; font-size: 0.72rem; color: var(--ink-soft);
}
.chip-ok { border-color: var(--ok); color: var(--ok); }
.chip-warn { border-color: var(--brass-text); color: var(--brass-text); }
${
  options.hasAlert
    ? `.chip-critical { border-color: var(--alert); color: var(--alert); }
.flag-count { font-family: ${DISPLAY_SERIF}; font-size: 3rem; line-height: 1; color: var(--alert); }
.critical-row { background: var(--alert-wash); }
.rule-alert { border-left: 3px solid var(--alert); padding-left: 0.8rem; }`
    : `.flag-count { font-family: ${DISPLAY_SERIF}; font-size: 3rem; line-height: 1; color: var(--brass-text); }`
}

/* --- treaty caveat: must read as a caution, not a footnote --------------- */
.treaty-note {
  border: 1px solid var(--brass); background: var(--paper-sunk);
  padding: 0.85rem 0.95rem; margin: 1rem 0 1.2rem;
}
.treaty-note p { margin: 0.3rem 0 0; font-size: 0.86rem; }
.treaty-note .byline {
  font-size: 0.68rem; letter-spacing: 0.14em; text-transform: uppercase;
  color: var(--brass-text); font-weight: 600; margin: 0;
}
.sources { margin-top: 0.35rem; font-size: 0.78rem; color: var(--ink-soft); }
.sources-label { text-transform: uppercase; letter-spacing: 0.1em; font-size: 0.64rem; }
.contested { color: var(--brass-text); }

/* --- commentary ---------------------------------------------------------- */
.commentary { border-left: 2px solid var(--brass-soft); padding: 0.1rem 0 0.1rem 0.85rem; margin: 0.9rem 0; }
.commentary .byline {
  font-size: 0.68rem; letter-spacing: 0.14em; text-transform: uppercase;
  color: var(--brass-text); font-weight: 600;
}

.warnings { list-style: none; padding: 0; margin: 0.6rem 0 0; }
.warnings li { font-size: 0.8rem; color: var(--ink-soft); padding-left: 1rem; text-indent: -1rem; }
.warnings li::before { content: "— "; color: var(--brass-text); }

footer {
  margin-top: 3rem; border-top: 1px solid var(--rule-strong); padding-top: 1rem;
  font-size: 0.75rem; color: var(--ink-soft);
}
code, .mono { font-family: ${MONO}; font-size: 0.78em; }

/* --- desktop is an enhancement, not the design --------------------------- */
@media (min-width: 900px) {
  main { max-width: 60rem; padding: 2rem 2rem 5rem; }
  .grid { grid-template-columns: 1fr 1fr; gap: 1rem; }
  body { font-size: 17px; }
}

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { transition-duration: 0.01ms !important; animation-duration: 0.01ms !important; }
}

/* --- print: A4, no interactive chrome ------------------------------------ */
@page { size: A4; margin: 16mm 14mm; }
@media print {
  body { background: #fff; font-size: 10.5pt; }
  main { max-width: none; padding: 0; }
  .no-print { display: none !important; }
  section { break-inside: avoid; border-top: 1px solid #ccc; }
  h2, h3 { break-after: avoid; }
  table { font-size: 9pt; }
  .col-detail { display: table-cell; }
  .scroll { overflow: visible; border: none; }
  a { text-decoration: none; color: inherit; }
}
${
  options.deck
    ? `
/* --- deck mode: one idea per page ---------------------------------------- */
.slide {
  min-height: 100svh; max-height: 100svh; overflow: hidden;
  display: flex; flex-direction: column; justify-content: center;
  border-top: none; padding: 1.5rem 0; scroll-snap-align: start; margin-top: 0;
}
.slide h2 { font-size: clamp(1.4rem, 5vw, 2rem); }
.slide table { font-size: 0.92rem; }
html { scroll-snap-type: y proximity; }
@media print { .slide { min-height: 0; break-after: page; } }`
    : ""
}
`;
}
