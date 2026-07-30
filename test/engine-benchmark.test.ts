import { test } from "node:test";
import assert from "node:assert/strict";
import { readJson } from "./helpers.ts";
import { levelAt, seriesReturn, compositeReturn, compareToBenchmark } from "../src/engine/benchmark.ts";
import { modifiedDietz, timeWeightedReturn, realReturn } from "../src/engine/performance.ts";
import type { IndexSeries } from "../src/engine/benchmark.ts";

// SPEC §6.2: "Benchmarks: user-assigned composite per account (e.g., 60/40 in
// GBP terms) from bundled index series (params/shared/benchmarks/, monthly,
// extendable). Report both nominal and real (CPI series in params)."
const equity = readJson("params/shared/benchmarks/global_equity_gbp.json") as IndexSeries;
const bonds = readJson("params/shared/benchmarks/global_bonds_gbp.json") as IndexSeries;
const usEquity = readJson("params/shared/benchmarks/us_equity_usd.json") as IndexSeries;
const cpiUk = readJson("params/shared/benchmarks/cpi_uk.json") as IndexSeries;

const FROM = "2025-06-30";
const TO = "2026-06-30";
// Levels read directly from the committed series files:
//   equity 118.4793 -> 121.9837 ; bonds 108.6648 -> 111.9234 ; cpi 107.0092 -> 109.7310
const EQUITY_RETURN = 121.9837 / 118.4793 - 1;
const BOND_RETURN = 111.9234 / 108.6648 - 1;
const CPI_RETURN = 109.731 / 107.0092 - 1;

test("an index level is read on or before the date asked for, never after", () => {
  const exact = levelAt(equity, "2026-06-30");
  assert.equal(exact!.date, "2026-06-30");
  // Mid-month: must fall back to the previous month-end, not reach forward.
  const midMonth = levelAt(equity, "2026-06-15");
  assert.equal(midMonth!.date, "2026-05-31");
  assert.equal(levelAt(equity, "2020-01-01"), null, "before the series starts there is no level");
});

test("a single series return matches the committed levels", () => {
  const result = seriesReturn(equity, FROM, TO);
  assert.ok(Math.abs(result.return - EQUITY_RETURN) < 1e-12);
  assert.deepEqual(result.warnings, []);
});

test("a 60/40 composite is the weighted sum of its components (§6.2)", () => {
  const composite = compositeReturn(
    [
      { series: equity, weight: 0.6 },
      { series: bonds, weight: 0.4 },
    ],
    FROM,
    TO
  );
  const expected = 0.6 * EQUITY_RETURN + 0.4 * BOND_RETURN;
  assert.ok(Math.abs(composite.return - expected) < 1e-12, `${composite.return} != ${expected}`);
  assert.equal(composite.currency, "GBP");
  assert.equal(composite.components.length, 2);
  assert.match(composite.assumption, /60% global_equity_gbp \/ 40% global_bonds_gbp/);
  assert.match(composite.assumption, /rebalanced continuously/, "the rebalancing convention must be stated");
});

test("weights that do not sum to one are refused", () => {
  assert.throws(
    () => compositeReturn([{ series: equity, weight: 0.6 }, { series: bonds, weight: 0.3 }], FROM, TO),
    /weights sum to/
  );
});

test("a composite cannot mix currencies without an explicit conversion", () => {
  assert.throws(
    () => compositeReturn([{ series: equity, weight: 0.5 }, { series: usEquity, weight: 0.5 }], FROM, TO),
    /span GBP, USD/
  );
});

test("portfolio vs benchmark reports nominal AND real, and carries the method label (§6.2)", () => {
  const benchmark = compositeReturn(
    [{ series: equity, weight: 0.6 }, { series: bonds, weight: 0.4 }],
    FROM,
    TO
  );
  const portfolio = timeWeightedReturn([
    { date: FROM, value: 100000 },
    { date: TO, value: 105000 },
  ]);

  const comparison = compareToBenchmark({ portfolio, benchmark, cpi: cpiUk, from: FROM, to: TO });

  assert.ok(Math.abs(comparison.portfolio.nominal - 0.05) < 1e-12);
  assert.ok(Math.abs(comparison.inflation - CPI_RETURN) < 1e-12);
  assert.ok(Math.abs(comparison.portfolio.real - realReturn(0.05, { start: 107.0092, end: 109.731 })) < 1e-12);
  assert.ok(comparison.portfolio.real < comparison.portfolio.nominal, "inflation was positive over this period");
  assert.ok(Math.abs(comparison.excessNominal - (0.05 - benchmark.return)) < 1e-12);
  assert.equal(comparison.portfolio.method, "twr");
  assert.equal(comparison.portfolio.isEstimate, false);
  assert.deepEqual(comparison.warnings, []);
});

test("an estimated portfolio return warns that the excess carries its error", () => {
  const benchmark = compositeReturn([{ series: equity, weight: 1 }], FROM, TO);
  const portfolio = modifiedDietz({
    start: { date: FROM, value: 100000 },
    end: { date: TO, value: 108000 },
    flows: [{ date: "2025-12-31", amount: 2000 }],
  });
  const comparison = compareToBenchmark({ portfolio, benchmark, cpi: cpiUk, from: FROM, to: TO });

  assert.equal(comparison.portfolio.isEstimate, true);
  assert.equal(comparison.portfolio.method, "modified_dietz");
  assert.ok(
    comparison.warnings.some((w) => /estimate/.test(w) && /difference between them/.test(w)),
    "comparing an estimate against an exact index must be flagged, not presented as precision"
  );
});

test("a comparison period that does not line up with the monthly index warns", () => {
  // The series is month-end; asking from a date whose nearest prior observation
  // is more than a month back means the periods genuinely do not align.
  const shortSeries: IndexSeries = {
    name: "sparse_test",
    currency: "GBP",
    frequency: "monthly",
    series: [
      { date: "2025-01-31", value: 100 },
      { date: "2026-06-30", value: 120 },
    ],
  };
  const result = seriesReturn(shortSeries, FROM, TO);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0]!, /does not line up with the index/);
});

test("all bundled benchmark series are usable by the engine", () => {
  for (const name of ["global_equity_gbp", "global_bonds_gbp", "us_equity_usd", "gbp_cash", "cpi_uk", "cpi_us"]) {
    const series = readJson(`params/shared/benchmarks/${name}.json`) as IndexSeries;
    const result = seriesReturn(series, FROM, TO);
    assert.ok(Number.isFinite(result.return), `${name} did not produce a finite return`);
  }
});
