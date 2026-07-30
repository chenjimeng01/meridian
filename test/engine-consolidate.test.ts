import { test } from "node:test";
import assert from "node:assert/strict";
import { readJson } from "./helpers.ts";
import { consolidate } from "../src/engine/consolidate.ts";
import { assessRisk } from "../src/engine/risk.ts";
import { FxUnavailableError } from "../src/engine/fx.ts";
import type { Ledger } from "../src/ingest/types.ts";

const assetClasses = readJson("params/shared/asset-classes.json");
const fxPolicy = readJson("params/shared/fx-policy.json");
const ASOF = "2026-06-30";
const roundTo = (value: number, dp: number) => Number(value.toFixed(dp));

function load(name: string) {
  const ledger = readJson(`test/fixtures/ledger/${name}.json`) as Ledger;
  return {
    ledger,
    result: consolidate({
      ledger,
      assetClasses,
      fx: { rates: ledger.fx_rates, policy: fxPolicy },
      asof: ASOF,
    }),
  };
}

// Expected values derived by hand from the acceptance fixture at GBPUSD 1.28:
//   A1 GIA   27,762.50 + 13,660.00 + 29,259.00 + 11,358.00 + 15,156.00
//            + 10,700.00 + 1,215.80                       = 109,111.30
//   A2 ISA   17,768.00 + 101.12                           =  17,869.12
//   A3 SIPP  73,485.00 + 2,305.00                         =  75,790.00
//   A4 401k  (45,705.00 + 12,451.15 + 152.40) / 1.28      =  45,553.55
//   total                                                  = 248,323.97
const TOTAL_GBP = 248323.97;

test("total wealth consolidates across currencies to the expected figure (§6.1)", () => {
  const { result } = load("household-usuk-acceptance");
  assert.equal(result.total.base.amount, TOTAL_GBP);
  assert.equal(result.total.base.currency, "GBP");
  assert.equal(result.total.secondary!.currency, "USD", "dual currency is the signature of the product");
  // Converted from the UNROUNDED base total 248,323.9746875 x 1.28 =
  // 317,854.6876125. Converting the rounded base instead would give
  // 317,854.68 — a penny out, and the source of the M2 reconciliation break.
  assert.equal(result.total.secondary!.amount, 317854.69);
});

// PHASE_REVIEW_3 M2: this previously summed only `.base` with a 0.05 tolerance,
// which could not see the penny break in the USD column. Both columns are now
// asserted to the exact penny.
test("every slice sums back to the total in BOTH currencies, exactly (§6.1, §8)", () => {
  const { result } = load("household-usuk-acceptance");
  const sum = (values: number[]) => Math.round(values.reduce((t, v) => t + v, 0) * 100) / 100;

  for (const [name, slices] of [
    ["byAccount", result.byAccount],
    ["byWrapper", result.byWrapper],
    ["byJurisdiction", result.byJurisdiction],
    ["byAssetClass", result.byAssetClass],
    ["byCurrency", result.byCurrency],
    ["byLiquidityTier", result.byLiquidityTier],
    ["byInstrument", result.byInstrument],
    ["byPerson", result.byPerson],
  ] as const) {
    assert.equal(sum(slices.map((s) => s.value.base.amount)), result.total.base.amount, `${name} base column must add up to the headline`);
    assert.equal(
      sum(slices.map((s) => s.value.secondary!.amount)),
      result.total.secondary!.amount,
      `${name} secondary column must add up to the headline — a column that does not add up is not renderable`
    );
  }
});

test("wrapper, jurisdiction and asset-class slices are right", () => {
  const { result } = load("household-usuk-acceptance");
  const by = (slices: any[], key: string) => slices.find((s) => s.key === key)?.value.base.amount;

  assert.equal(by(result.byWrapper, "gia"), 109111.3);
  assert.equal(by(result.byWrapper, "isa"), 17869.12);
  assert.equal(by(result.byWrapper, "sipp"), 75790);
  assert.equal(by(result.byWrapper, "401k"), 45553.55);

  assert.equal(by(result.byJurisdiction, "UK"), 202770.42);
  assert.equal(by(result.byJurisdiction, "US"), 45553.55);

  // equity = OEICs 59,190.50 + UCITS ETF 102,744.00 + direct shares 26,514.00
  //          + US mutual fund 35,707.03
  assert.equal(by(result.byAssetClass, "equity"), 224155.53);
  assert.equal(by(result.byAssetClass, "alternative"), 10700, "the unconfirmed pooled fund");
  assert.equal(by(result.byAssetClass, "cash"), 13468.44, "MMF plus cash balances");
});

test("an instrument held in several accounts consolidates to one position", () => {
  const { result } = load("household-usuk-acceptance");
  const atlas = result.byInstrument.find((s) => s.label.startsWith("Atlas"))!;
  // 29,259.00 in the GIA + 73,485.00 in the SIPP
  assert.equal(atlas.value.base.amount, 102744);
  assert.equal(result.byInstrument.filter((s) => s.label.startsWith("Atlas")).length, 1);
});

test("liquidity tiers separate same-day money from funds that take days to sell", () => {
  const { result } = load("household-usuk-acceptance");
  const tier = (key: string) => result.byLiquidityTier.find((s) => s.key === key)?.value.base.amount;
  assert.equal(tier("t0"), 13468.44, "cash and money-market");
  assert.equal(tier("t1"), 129258, "ETF and direct shares");
  assert.equal(tier("t2_5"), 105597.53, "OEICs, US mutual fund and the unconfirmed pooled fund");
});

test("consolidation states its look-through and joint-ownership assumptions", () => {
  const { result } = load("household-usuk-acceptance");
  assert.ok(
    result.warnings.some((w) => /look-through/.test(w)),
    "currency exposure is a proxy in v0 and must say so"
  );
});

test("concentration flags every position above the params threshold (§6.4)", () => {
  const { ledger, result } = load("household-usuk-acceptance");
  const risk = assessRisk({ consolidation: result, ledger: ledger as any, assetClasses, asof: ASOF });

  const flagged = risk.singleIssuerFlags.map((f) => f.label).sort();
  assert.deepEqual(flagged, [
    "Amalgamated Tech Inc Common Stock",
    "Atlas Global Equity UCITS ETF",
    "Northgate UK Smaller Companies OEIC",
    "Pioneer S&P Index Fund",
    "Sterling Park UK Equity Income OEIC Acc",
  ]);
  // Thames Utilities is 11,358 / 248,323.97 = 4.57% — below the 5% threshold.
  assert.ok(!flagged.includes("Thames Utilities PLC Ordinary 25p"));

  assert.ok(risk.topPositions.length <= 10);
  assert.equal(risk.topPositions[0]!.label, "Atlas Global Equity UCITS ETF");
});

test("wrapped-vs-unwrapped ratio is reported per jurisdiction (§6.4)", () => {
  const { ledger, result } = load("household-usuk-acceptance");
  const risk = assessRisk({ consolidation: result, ledger: ledger as any, assetClasses, asof: ASOF });

  const uk = risk.wrappedRatioByJurisdiction.UK!;
  assert.equal(uk.wrapped, 93659.12, "ISA + SIPP");
  assert.equal(uk.unwrapped, 109111.3, "the GIA");
  assert.ok(Math.abs(uk.wrappedShare - 93659.12 / 202770.42) < 1e-9);

  const us = risk.wrappedRatioByJurisdiction.US!;
  assert.equal(us.wrapped, 45553.55, "the 401(k)");
  assert.equal(us.unwrapped, 0);
});

test("geographic split follows instrument domicile and does not guess for cash", () => {
  const { ledger, result } = load("household-usuk-acceptance");
  const risk = assessRisk({ consolidation: result, ledger: ledger as any, assetClasses, asof: ASOF });
  const share = (key: string) => risk.geographicSplit.find((s) => s.key === key)?.value.base.amount;
  assert.equal(share("IE"), 102744, "the Irish-domiciled UCITS ETF");
  assert.equal(share("JE"), 10700, "the Jersey pooled fund");
  assert.ok(share("unallocated")! > 0, "cash is not attributed to a country");
  assert.ok(risk.warnings.some((w) => /domicile is not confirmed/.test(w)));
});

// --- §6 acceptance criterion (c), through consolidation (PHASE_REVIEW_3 M1) --
// The awkwardness was previously only exercised at the convert() unit, leaving
// consolidation's staleness and missing-rate paths dead in the suite.

test("dual-currency consolidation survives a deliberately awkward FX date mismatch (§6.1)", () => {
  const ledger = readJson("test/fixtures/ledger/household-fx-mismatch.json") as Ledger;
  const result = consolidate({
    ledger,
    assetClasses,
    fx: { rates: ledger.fx_rates, policy: fxPolicy },
    asof: ASOF,
  });

  // No rate is dated on ANY valuation date in this ledger:
  //   GBP 10,000            no conversion needed
  //   USD 12,800 @ 2026-06-30 -> 2026-06-10 rate 1.28        = 10,000.00
  //   EUR  5,400 @ 2026-06-30 -> no GBPEUR; via USD 1.08/1.28 =  4,556.25
  //   USD  2,500 @ 2026-02-15 -> 2026-01-31 rate 1.25         =  2,000.00
  assert.equal(result.total.base.amount, 26556.25);
  assert.equal(result.total.secondary!.amount, 33992);

  const byCurrency = Object.fromEntries(result.byCurrency.map((s) => [s.key, s.value.base.amount]));
  assert.equal(byCurrency.GBP, 10000);
  assert.equal(byCurrency.USD, 12000, "both USD holdings, each at its own date's rate");
  assert.equal(byCurrency.EUR, 4556.25, "triangulated via USD");

  // Staleness must reach the consolidation warnings, not just the FX unit.
  const stale = result.warnings.filter((w) => /stale/.test(w));
  assert.equal(stale.length, 2, "one warning per stale conversion date");
  assert.ok(stale.some((w) => /20 days stale \(dated 2026-06-10/.test(w)));
  assert.ok(stale.some((w) => /15 days stale \(dated 2026-01-31/.test(w)));

  // And the columns still reconcile under all that.
  const sum = (v: number[]) => Math.round(v.reduce((t, x) => t + x, 0) * 100) / 100;
  assert.equal(sum(result.byInstrument.map((s) => s.value.base.amount)), result.total.base.amount);
  assert.equal(sum(result.byInstrument.map((s) => s.value.secondary!.amount)), result.total.secondary!.amount);
});

test("consolidation refuses rather than guessing when a holding cannot be valued in base", () => {
  const ledger = readJson("test/fixtures/ledger/household-fx-mismatch.json") as Ledger;
  // Only the January rate survives, so a June USD holding is 150 days stale —
  // past the policy's refusal limit.
  const staleOnly = ledger.fx_rates.filter((r: any) => r.date === "2026-01-31");
  assert.throws(
    () => consolidate({ ledger, assetClasses, fx: { rates: staleOnly, policy: fxPolicy }, asof: ASOF }),
    (err: unknown) => {
      assert.ok(err instanceof FxUnavailableError);
      assert.match((err as Error).message, /beyond the 31-day policy limit/);
      return true;
    }
  );
});

test("a missing secondary rate degrades the second column without sinking the report", () => {
  const ledger = readJson("test/fixtures/ledger/household-fx-mismatch.json") as Ledger;
  const result = consolidate({
    ledger,
    assetClasses,
    fx: { rates: ledger.fx_rates, policy: fxPolicy },
    asof: ASOF,
    secondaryCurrency: "JPY", // never quoted anywhere in this ledger
  });
  assert.equal(result.total.base.amount, 26556.25, "the base column still stands");
  assert.equal(result.total.secondary, undefined, "and the missing column is absent, not zero");
  assert.ok(
    result.warnings.some((w) => /secondary-currency figure unavailable/.test(w)),
    "the omission must be visible"
  );
  for (const slice of result.byInstrument) {
    assert.equal(slice.value.secondary, undefined);
  }
});

// PHASE_REVIEW_4 S8: a statement is a complete picture of its account on its
// date, so a position missing from the newest one has been sold. Taking the
// latest snapshot per (account, instrument) resurrected every disposed
// position forever — it stayed in the total, the concentration flags and the
// PFIC list.
test("a position absent from the newest statement is treated as sold (§6.1)", () => {
  const ledger = structuredClone(readJson("test/fixtures/ledger/household-usuk-acceptance.json")) as any;
  const account = ledger.accounts[0];
  const sold = ledger.instruments.find((i: any) => i.name.startsWith("Thames"))!;

  // Back-date the whole account to an earlier statement, then add a NEWER
  // statement that omits the Thames holding: the client sold it.
  for (const holding of ledger.holdings.filter((h: any) => h.account_id === account.id)) {
    holding.asof = "2026-03-31";
  }
  for (const holding of ledger.holdings.filter((h: any) => h.account_id === account.id && h.instrument_id !== sold.id)) {
    ledger.holdings.push({ ...holding, asof: "2026-06-30" });
  }

  const result = consolidate({
    ledger,
    assetClasses,
    fx: { rates: ledger.fx_rates, policy: fxPolicy },
    asof: ASOF,
  });

  assert.equal(
    result.byInstrument.some((slice) => slice.label.startsWith("Thames")),
    false,
    "a sold holding must leave the consolidation, not linger forever"
  );
  // And the total falls by exactly the disposed position.
  assert.equal(result.total.base.amount, roundTo(TOTAL_GBP - 11358, 2));
});

test("concentration is measured against investable wealth, not total (§6.4)", () => {
  const { ledger, result } = load("household-usuk-acceptance");
  const risk = assessRisk({ consolidation: result, ledger: ledger as any, assetClasses, asof: ASOF });

  assert.ok(risk.investableWealth.amount < result.total.base.amount, "cash is excluded from the base");
  assert.deepEqual(risk.investableWealth.excludedTypes, ["cash", "property"]);

  // Each flagged share must be of investable wealth — measuring against total
  // understates every position by however much cash happens to sit beside it.
  for (const flag of risk.singleIssuerFlags) {
    assert.ok(
      Math.abs(flag.share - flag.amount / risk.investableWealth.amount) < 1e-6,
      `${flag.label} share is measured against the wrong base`
    );
    assert.ok(flag.share > flag.amount / result.total.base.amount, "the investable share must exceed the total share");
  }
  assert.equal(
    risk.singleIssuerFlags.some((flag) => flag.label.startsWith("Cash")),
    false,
    "cash is not a concentrated position"
  );
});

test("the UK-only household consolidates without a secondary currency", () => {
  const { result } = load("household-uk-only");
  // 22,210.00 + 7,572.00 + 11,105.00 + 480.50
  assert.equal(result.total.base.amount, 41367.5);
  assert.equal(result.total.secondary, undefined);
  assert.equal(result.byJurisdiction.length, 1);
});
