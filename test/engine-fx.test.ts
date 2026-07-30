import { test } from "node:test";
import assert from "node:assert/strict";
import { readJson } from "./helpers.ts";
import { convert, findRate, FxUnavailableError, roundHalfEven } from "../src/engine/fx.ts";

const policy = readJson("params/shared/fx-policy.json");

// SPEC §6 Phase 3 acceptance: "dual-currency consolidation with a deliberately
// awkward FX date-mismatch fixture". The awkwardness is the point — a rate on
// the wrong side of the valuation date, a stale rate, a missing direct pair.
const RATES = [
  { date: "2026-05-20", pair: "GBPUSD", rate: 1.24, source: "statement:a" },
  { date: "2026-06-25", pair: "GBPUSD", rate: 1.28, source: "statement:b" },
  { date: "2026-07-15", pair: "GBPUSD", rate: 1.31, source: "statement:c" }, // AFTER most valuations
  { date: "2026-06-25", pair: "EURUSD", rate: 1.08, source: "statement:d" },
];

const ctx = { rates: RATES, policy };

test("an exact-date rate converts cleanly with no warning", () => {
  const out = convert({ amount: 1000, currency: "GBP" }, "USD", "2026-06-25", ctx);
  assert.equal(out.amount, 1280);
  assert.equal(out.currency, "USD");
  assert.equal(out.rate, 1.28);
  assert.equal(out.rateDate, "2026-06-25");
  assert.deepEqual(out.warnings, []);
});

test("a rate later than the valuation date is never used (§ fx-policy date_mismatch_rule)", () => {
  // 2026-06-30 sits between the 06-25 rate and the 07-15 rate. Using 07-15
  // would make the valuation unreproducible from data available on the day.
  const out = convert({ amount: 1000, currency: "GBP" }, "USD", "2026-06-30", ctx);
  assert.equal(out.rate, 1.28, "must use the 06-25 rate, not the closer 07-15 one");
  assert.equal(out.rateDate, "2026-06-25");
  assert.deepEqual(out.warnings, [], "5 days stale is within the clean window");
});

test("a rate staler than the policy window converts but warns", () => {
  const out = convert({ amount: 1000, currency: "GBP" }, "USD", "2026-07-10", ctx);
  assert.equal(out.rateDate, "2026-06-25", "15 days stale");
  assert.equal(out.rate, 1.28);
  assert.equal(out.warnings.length, 1);
  assert.match(out.warnings[0]!, /15 days/);
  assert.match(out.warnings[0]!, /stale/i);
});

test("a rate beyond the refusal threshold is refused, not silently used", () => {
  // Newest usable rate is 2026-07-15; a 2026-08-20 valuation is 36 days later,
  // past the 31-day refusal limit.
  assert.throws(
    () => convert({ amount: 1000, currency: "GBP" }, "USD", "2026-08-20", ctx),
    (err: unknown) => {
      assert.ok(err instanceof FxUnavailableError);
      assert.match((err as Error).message, /36 days/);
      assert.match((err as Error).message, /manual/i);
      return true;
    }
  );
  // Just inside the limit it converts, but never silently — the staleness is
  // surfaced as a warning on the figure.
  const borderline = convert({ amount: 1000, currency: "GBP" }, "USD", "2026-08-01", ctx);
  assert.equal(borderline.rateDate, "2026-07-15");
  assert.equal(borderline.warnings.length, 1);
});

test("no rate at all on or before the valuation date is refused", () => {
  assert.throws(
    () => convert({ amount: 1000, currency: "GBP" }, "USD", "2026-01-01", ctx),
    FxUnavailableError
  );
});

test("the inverse pair is derived when only one direction is quoted", () => {
  const out = convert({ amount: 1280, currency: "USD" }, "GBP", "2026-06-25", ctx);
  assert.equal(out.amount, 1000);
  assert.equal(out.currency, "GBP");
});

test("a missing direct pair triangulates via USD (§ fx-policy cross_rate_rule)", () => {
  // GBPEUR is not quoted; GBPUSD 1.28 and EURUSD 1.08 give 1.28/1.08.
  const out = convert({ amount: 1000, currency: "GBP" }, "EUR", "2026-06-25", ctx);
  const expected = roundHalfEven((1000 * 1.28) / 1.08, 2);
  assert.equal(out.amount, expected);
  assert.equal(out.currency, "EUR");
  assert.ok(Math.abs(out.rate - 1.28 / 1.08) < 1e-9);
  assert.ok(out.via === "USD", "the triangulation must be disclosed, not hidden");
});

test("same-currency conversion is the identity and needs no rate", () => {
  const out = convert({ amount: 42.5, currency: "GBP" }, "GBP", "2020-01-01", { rates: [], policy });
  assert.equal(out.amount, 42.5);
  assert.equal(out.rate, 1);
  assert.deepEqual(out.warnings, []);
});

test("findRate picks the most recent rate on or before the date", () => {
  const found = findRate("GBP", "USD", "2026-06-24", RATES);
  assert.equal(found!.date, "2026-05-20");
  assert.equal(found!.rate, 1.24);
});

test("amounts round half-even to the penny, as the policy states", () => {
  assert.equal(roundHalfEven(2.345, 2), 2.34);
  assert.equal(roundHalfEven(2.355, 2), 2.36);
  assert.equal(roundHalfEven(-2.345, 2), -2.34);
  assert.equal(roundHalfEven(1.005, 2), 1.0);
});

test("dual-currency pair renders both sides from one source of truth", () => {
  // The signature of the product: a value is never shown in one currency only.
  const gbp = { amount: 85724.53, currency: "GBP" };
  const usd = convert(gbp, "USD", "2026-06-30", ctx);
  assert.equal(usd.amount, roundHalfEven(85724.53 * 1.28, 2));
  const roundTrip = convert(usd, "GBP", "2026-06-30", ctx);
  assert.ok(Math.abs(roundTrip.amount - gbp.amount) < 0.01, "round-trip must not drift more than a penny");
});
