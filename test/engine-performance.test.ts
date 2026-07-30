import { test } from "node:test";
import assert from "node:assert/strict";
import { timeWeightedReturn, xirr, modifiedDietz, chainLink } from "../src/engine/performance.ts";

// SPEC §6 Phase 3 acceptance: "TWR vs XIRR divergence case" and "Modified
// Dietz vs known TWR tolerance case". Both cases below are constructed so the
// correct answer is known in closed form, independently of the implementation.

// Case A — the classic divergence. £100 doubles, then the investor adds £800
// at the top, then the whole thing halves.
//   Sub-period returns: +100%, then -50%  →  TWR = 2.0 × 0.5 - 1 = 0 exactly.
//   Money-weighted: the big contribution was made just before the fall, so the
//   investor's actual experience is a heavy loss.
//   NPV: -100 - 800x + 500x^2 = 0 where x = 1/(1+r) and the dates are exactly
//   one and two 365-day years apart. => 5x^2 - 8x - 1 = 0 => x = (8+sqrt(84))/10
//   => r = 10/(8+sqrt(84)) - 1 = -0.4174243050441604...
const CASE_A = {
  valuations: [
    { date: "2025-01-01", value: 100 },
    { date: "2026-01-01", value: 200 }, // before the flow
    { date: "2027-01-01", value: 500 },
  ],
  flows: [
    { date: "2025-01-01", amount: 100 }, // initial investment
    { date: "2026-01-01", amount: 800 }, // contribution at the peak
  ],
};
const CASE_A_XIRR = 10 / (8 + Math.sqrt(84)) - 1;

test("TWR is flat while XIRR is deeply negative — the divergence case (§6.2)", () => {
  const twr = timeWeightedReturn([
    { start: { date: "2025-01-01", value: 100 }, end: { date: "2026-01-01", value: 200 }, flowAtEnd: 800 },
    { start: { date: "2026-01-01", value: 1000 }, end: { date: "2027-01-01", value: 500 }, flowAtEnd: 0 },
  ]);
  assert.equal(twr.return, 0, "TWR must be exactly zero: +100% then -50%");
  assert.equal(twr.method, "twr");

  const mwr = xirr([
    { date: "2025-01-01", amount: -100 },
    { date: "2026-01-01", amount: -800 },
    { date: "2027-01-01", amount: 500 },
  ]);
  assert.ok(Math.abs(mwr - CASE_A_XIRR) < 1e-9, `XIRR ${mwr} != closed form ${CASE_A_XIRR}`);
  assert.ok(mwr < -0.41 && mwr > -0.42, "money-weighted return reflects the badly-timed contribution");

  // The product's point: reporting only one of these would mislead.
  assert.ok(Math.abs(twr.return - mwr) > 0.4, "divergence must be surfaced, not averaged away");
});

test("XIRR handles the trivial doubling case and sign conventions", () => {
  const r = xirr([
    { date: "2025-01-01", amount: -1000 },
    { date: "2026-01-01", amount: 2000 },
  ]);
  assert.ok(Math.abs(r - 1) < 1e-9, `expected 100%, got ${r}`);
});

test("XIRR reports no solution rather than guessing when all flows share a sign", () => {
  assert.throws(
    () => xirr([
      { date: "2025-01-01", amount: -100 },
      { date: "2026-01-01", amount: -100 },
    ]),
    /sign/i
  );
});

// Case B — Modified Dietz against a known TWR.
//   True sub-period returns are +10% and +10%  =>  TWR = 21% exactly.
//   One flow of +500 exactly half-way through a 364-day period (day 182 of 364,
//   so the Dietz weight is exactly 0.5):
//   Dietz = (1760 - 1000 - 500) / (1000 + 0.5*500) = 260 / 1250 = 20.8% exactly.
test("Modified Dietz approximates a known TWR within a stated tolerance (§6.2)", () => {
  const dietz = modifiedDietz({
    start: { date: "2025-01-01", value: 1000 },
    end: { date: "2025-12-31", value: 1760 },
    flows: [{ date: "2025-07-02", amount: 500 }],
  });
  assert.equal(dietz.return, 0.208, "Modified Dietz is exactly 260/1250 for this fixture");
  assert.equal(dietz.method, "modified_dietz");
  assert.equal(dietz.isEstimate, true, "§6.2 requires the estimate to be labelled");
  assert.match(dietz.assumption, /weight|flow/i, "the assumption must be stated in words");

  const trueTwr = timeWeightedReturn([
    { start: { date: "2025-01-01", value: 1000 }, end: { date: "2025-07-02", value: 1100 }, flowAtEnd: 500 },
    { start: { date: "2025-07-02", value: 1600 }, end: { date: "2025-12-31", value: 1760 }, flowAtEnd: 0 },
  ]);
  assert.ok(Math.abs(trueTwr.return - 0.21) < 1e-12, "control: true TWR is 21%");

  const divergence = Math.abs(dietz.return - trueTwr.return);
  assert.ok(divergence < 0.005, `Dietz should track TWR within 50bps here, diverged ${divergence}`);
  assert.ok(divergence > 0, "and it is an approximation, not an identity");
});

test("Modified Dietz weights a late flow less than an early one", () => {
  const early = modifiedDietz({
    start: { date: "2025-01-01", value: 1000 },
    end: { date: "2025-12-31", value: 1600 },
    flows: [{ date: "2025-01-31", amount: 500 }],
  });
  const late = modifiedDietz({
    start: { date: "2025-01-01", value: 1000 },
    end: { date: "2025-12-31", value: 1600 },
    flows: [{ date: "2025-12-01", amount: 500 }],
  });
  assert.ok(late.return > early.return, "money present for less of the period earns a higher implied return");
});

test("chain-linking compounds sub-period returns and carries the weakest method label", () => {
  const linked = chainLink([
    { return: 0.1, method: "twr", isEstimate: false, assumption: "" },
    { return: 0.1, method: "modified_dietz", isEstimate: true, assumption: "flows weighted by time" },
  ]);
  assert.ok(Math.abs(linked.return - 0.21) < 1e-12);
  assert.equal(linked.isEstimate, true, "one estimated sub-period makes the whole chain an estimate");
  assert.equal(linked.method, "modified_dietz");
});

test("a period with no flows gives identical TWR and Dietz", () => {
  const dietz = modifiedDietz({
    start: { date: "2025-01-01", value: 1000 },
    end: { date: "2025-12-31", value: 1100 },
    flows: [],
  });
  assert.ok(Math.abs(dietz.return - 0.1) < 1e-12);
});

test("real returns deflate nominal by a price index (§6.2)", async () => {
  const { realReturn } = await import("../src/engine/performance.ts");
  // 10% nominal with 4% inflation → (1.10/1.04) - 1 = 5.769230...%
  const real = realReturn(0.1, { start: 100, end: 104 });
  assert.ok(Math.abs(real - (1.1 / 1.04 - 1)) < 1e-12);
});

// Guard the golden inputs themselves so a future edit cannot quietly weaken
// the acceptance case.
test("performance golden inputs are unchanged", () => {
  assert.equal(CASE_A.valuations.length, 3);
  assert.equal(CASE_A.flows[1]!.amount, 800);
  assert.ok(Math.abs(CASE_A_XIRR + 0.4174243050441604) < 1e-15);
});
