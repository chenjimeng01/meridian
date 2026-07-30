// Hand-rolled SVG charts (SPEC §8: "charts drawn with hand-rolled SVG, not a
// chart library" — the 400KB budget does not survive a charting dependency).
//
// Text is HTML, not SVG text. An <svg> scaled with width:100% scales its own
// text with the container, so a label sized correctly at 390px becomes twice
// as large on a desktop. Only the geometry lives in the SVG; every word is
// real, selectable HTML that respects the reader's font size. The bars are
// therefore decorative and marked aria-hidden — the adjacent text already says
// what they say. Charts that genuinely carry information a screen reader
// cannot otherwise get (the drag projection, the cost band) keep role="img"
// and a <title>.
import { esc } from "./format.ts";

export interface Datum {
  label: string;
  value: number;
  tone?: "accent" | "ink" | "muted" | "alert";
}

const TONE_VAR: Record<string, string> = {
  accent: "var(--brass)",
  ink: "var(--ink)",
  muted: "var(--rule-strong)",
  alert: "var(--alert)",
};

const PALETTE = ["var(--brass)", "var(--ink)", "var(--rule-strong)", "var(--brass-soft)", "var(--ink-soft)"];

/** Horizontal bars: HTML label and value, with a decorative SVG bar beneath. */
export function barChart(data: Datum[], options: { title: string; formatValue: (value: number) => string }): string {
  if (!data.length) return "";
  const max = Math.max(...data.map((d) => Math.abs(d.value)), 1);

  const rows = data
    .map((datum) => {
      const width = ((Math.abs(datum.value) / max) * 100).toFixed(2);
      const fill = TONE_VAR[datum.tone ?? "accent"] ?? TONE_VAR.accent;
      return (
        `<li>` +
        `<span class="l">${esc(datum.label)}</span>` +
        `<span class="v num">${esc(options.formatValue(datum.value))}</span>` +
        `<svg class="bar" viewBox="0 0 100 4" preserveAspectRatio="none" aria-hidden="true" focusable="false">` +
        `<rect x="0" y="0" width="100" height="4" class="c-track"></rect>` +
        `<rect x="0" y="0" width="${width}" height="4" fill="${fill}"></rect>` +
        `</svg></li>`
      );
    })
    .join("");

  return `<figure class="chart"><figcaption class="visually-hidden">${esc(options.title)}</figcaption><ul class="bars">${rows}</ul></figure>`;
}

/** One stacked band showing composition, with an HTML legend carrying the values. */
export function stackedBar(data: Datum[], options: { title: string; formatValue: (value: number) => string }): string {
  const total = data.reduce((sum, d) => sum + Math.abs(d.value), 0);
  if (total <= 0) return "";

  let cursor = 0;
  const segments = data
    .map((datum, index) => {
      const width = (Math.abs(datum.value) / total) * 100;
      const rect =
        `<rect x="${cursor.toFixed(3)}" y="0" width="${width.toFixed(3)}" height="4" ` +
        `fill="${PALETTE[index % PALETTE.length]}"></rect>`;
      cursor += width;
      return rect;
    })
    .join("");

  const legend = data
    .map(
      (datum, index) =>
        `<li><span class="swatch" style="background:${PALETTE[index % PALETTE.length]}"></span>` +
        `${esc(datum.label)} <span class="num">${esc(options.formatValue(datum.value))}</span></li>`
    )
    .join("");

  const description = data.map((d) => `${d.label} ${options.formatValue(d.value)}`).join("; ");
  return (
    `<figure class="chart">` +
    `<svg class="band" viewBox="0 0 100 4" preserveAspectRatio="none" role="img">` +
    `<title>${esc(options.title)}</title><desc>${esc(description)}</desc>${segments}</svg>` +
    `<ul class="legend">${legend}</ul></figure>`
  );
}

/**
 * Two compounding paths — before and after costs — with the gap between them
 * filled. The gap IS the story, so it is the only filled area.
 */
export function dragChart(options: {
  title: string;
  years: number;
  startingValue: number;
  grossRate: number;
  netRate: number;
  formatValue: (value: number) => string;
}): string {
  const width = 100;
  const height = 34;
  const steps = Math.max(1, options.years);
  const grossAt = (year: number) => options.startingValue * Math.pow(1 + options.grossRate, year);
  const netAt = (year: number) => options.startingValue * Math.pow(1 + options.netRate, year);
  const max = grossAt(steps) || 1;

  const x = (year: number) => (year / steps) * width;
  const y = (value: number) => height - (value / max) * (height - 3) - 1.5;

  const gross: string[] = [];
  const net: string[] = [];
  for (let year = 0; year <= steps; year++) {
    gross.push(`${x(year).toFixed(2)},${y(grossAt(year)).toFixed(2)}`);
    net.push(`${x(year).toFixed(2)},${y(netAt(year)).toFixed(2)}`);
  }

  const description =
    `Over ${steps} years, growth before costs reaches ${options.formatValue(grossAt(steps))} ` +
    `while growth after costs reaches ${options.formatValue(netAt(steps))}.`;

  return (
    `<figure class="chart">` +
    `<svg class="drag" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img">` +
    `<title>${esc(options.title)}</title><desc>${esc(description)}</desc>` +
    `<polygon points="${gross.join(" ")} ${[...net].reverse().join(" ")}" class="c-gap"></polygon>` +
    `<polyline points="${gross.join(" ")}" class="c-line-gross" fill="none" vector-effect="non-scaling-stroke"></polyline>` +
    `<polyline points="${net.join(" ")}" class="c-line-net" fill="none" vector-effect="non-scaling-stroke"></polyline>` +
    `</svg>` +
    `<ul class="legend"><li><span class="swatch" style="background:var(--ink)"></span>Before costs` +
    `<span class="num">${esc(options.formatValue(grossAt(steps)))}</span></li>` +
    `<li><span class="swatch" style="background:var(--brass)"></span>After costs` +
    `<span class="num">${esc(options.formatValue(netAt(steps)))}</span></li></ul></figure>`
  );
}

/** Portfolio currency exposure against the currency the client actually spends in (§7.4). */
export function pairedBars(
  data: { label: string; a: number; b: number }[],
  options: { title: string; aLabel: string; bLabel: string }
): string {
  if (!data.length) return "";
  const max = Math.max(...data.flatMap((d) => [d.a, d.b]), 0.01);

  const rows = data
    .map(
      (datum) =>
        `<li><span class="l">${esc(datum.label)}</span>` +
        `<span class="v num">${(datum.a * 100).toFixed(0)}% / ${(datum.b * 100).toFixed(0)}%</span>` +
        `<svg class="bar bar-pair" viewBox="0 0 100 9" preserveAspectRatio="none" aria-hidden="true" focusable="false">` +
        `<rect x="0" y="0" width="${((datum.a / max) * 100).toFixed(2)}" height="4" fill="var(--brass)"></rect>` +
        `<rect x="0" y="5" width="${((datum.b / max) * 100).toFixed(2)}" height="4" fill="var(--ink)"></rect>` +
        `</svg></li>`
    )
    .join("");

  return (
    `<figure class="chart"><figcaption class="visually-hidden">` +
    `${esc(options.title)} — ${esc(options.aLabel)} above, ${esc(options.bLabel)} below</figcaption>` +
    `<ul class="bars">${rows}</ul></figure>`
  );
}
