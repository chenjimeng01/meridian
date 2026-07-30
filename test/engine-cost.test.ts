import { test } from "node:test";
import assert from "node:assert/strict";
import { readJson } from "./helpers.ts";
import { costStack, compoundingDrag } from "../src/engine/cost.ts";

// SPEC §6 Phase 3 acceptance: "cost-stack reconciliation to a synthetic MiFID
// disclosure to the penny." The disclosure below is the committed fixture
// test/fixtures/expected/sterling-park-wealth/mifid-costs-2025.json:
//   management 820.00 + fund OCF 198.00 + transactions 88.00 + FX 52.00
//   = 1,158.00 on an average portfolio value of 82,000.00
const MIFID_2025 = readJson("test/fixtures/expected/sterling-park-wealth/mifid-costs-2025.json") as any;
const DISCLOSED_TOTAL = 1158.0;
const AVERAGE_VALUE = 82000.0;

test("the fixture disclosure is the one the acceptance criterion names", () => {
  const fees = MIFID_2025.accounts[0].fees;
  assert.equal(fees.length, 4);
  const sum = fees.reduce((t: number, f: any) => t + f.amount.amount, 0);
  assert.equal(sum, DISCLOSED_TOTAL, "guard: the fixture still totals £1,158.00");
});

test("cost stack reconciles to the MiFID disclosure to the penny (§6.3)", () => {
  const stack = costStack({
    accounts: [
      {
        accountToken: "A5",
        averageValue: { amount: AVERAGE_VALUE, currency: "GBP" },
        fees: MIFID_2025.accounts[0].fees.map((f: any) => ({
          label: f.label,
          category: f.category,
          amount: f.amount,
          sourceDocument: "sterling-park-wealth/mifid-costs-2025.txt",
        })),
      },
    ],
    baseCurrency: "GBP",
  });

  assert.equal(stack.total.amount.amount, DISCLOSED_TOTAL, "total must match the disclosure exactly");
  assert.equal(stack.total.amount.currency, "GBP");

  // 1158 / 82000 = 0.0141219512195... → 141.22 bps
  assert.equal(stack.total.bps, 141.22);

  // Per-category breakdown must also reconcile, not just the total.
  assert.equal(stack.byCategory.platform!.amount.amount, 820.0);
  assert.equal(stack.byCategory.fund_ocf!.amount.amount, 198.0);
  assert.equal(stack.byCategory.transaction!.amount.amount, 88.0);
  assert.equal(stack.byCategory.fx_spread!.amount.amount, 52.0);
  const categorySum = Object.values(stack.byCategory).reduce((t, c: any) => t + c.amount.amount, 0);
  assert.equal(categorySum, DISCLOSED_TOTAL, "categories must sum to the total with no residue");

  // §6.3: every number traceable to a document.
  for (const line of stack.lines) {
    assert.ok(line.sourceDocument, `${line.label} has no source document`);
  }
});

test("every cost line is attributed, and an unattributed line is refused", () => {
  assert.throws(
    () =>
      costStack({
        accounts: [
          {
            accountToken: "A5",
            averageValue: { amount: 1000, currency: "GBP" },
            fees: [{ label: "Mystery charge", category: "other", amount: { amount: 10, currency: "GBP" } } as any],
          },
        ],
        baseCurrency: "GBP",
      }),
    /source/i,
    "§6.3 requires every number to be traceable to a document"
  );
});

test("20-year compounding drag uses the fee, not just this year's cash (§6.3)", () => {
  // £100,000 at 5% gross for 20 years, with a 1% annual fee:
  //   gross 100000 * 1.05^20 = 265,329.7705144422
  //   net   100000 * 1.04^20 = 219,112.3143033419
  //   drag  = 46,217.4562111003
  const drag = compoundingDrag({
    startingValue: { amount: 100000, currency: "GBP" },
    grossGrowthRate: 0.05,
    annualFeeRate: 0.01,
    years: 20,
  });
  assert.equal(drag.grossTerminal.amount, 265329.77);
  assert.equal(drag.netTerminal.amount, 219112.31);
  assert.equal(drag.drag.amount, 46217.46);
  assert.equal(drag.years, 20);
  assert.ok(Math.abs(drag.dragAsShareOfGross - 46217.4562111003 / 265329.7705144422) < 1e-6);
});

test("a zero fee produces zero drag", () => {
  const drag = compoundingDrag({
    startingValue: { amount: 50000, currency: "GBP" },
    grossGrowthRate: 0.05,
    annualFeeRate: 0,
    years: 20,
  });
  assert.equal(drag.drag.amount, 0);
});

test("costs across several accounts aggregate, and per-account bps stay separate", () => {
  const stack = costStack({
    accounts: [
      {
        accountToken: "A1",
        averageValue: { amount: 100000, currency: "GBP" },
        fees: [{ label: "Platform fee", category: "platform", amount: { amount: 250, currency: "GBP" }, sourceDocument: "d1" }],
      },
      {
        accountToken: "A2",
        averageValue: { amount: 50000, currency: "GBP" },
        fees: [{ label: "Platform fee", category: "platform", amount: { amount: 250, currency: "GBP" }, sourceDocument: "d2" }],
      },
    ],
    baseCurrency: "GBP",
  });
  assert.equal(stack.total.amount.amount, 500);
  assert.equal(stack.byAccount.A1!.bps, 25);
  assert.equal(stack.byAccount.A2!.bps, 50, "the same cash fee is twice the drag on half the money");
  // 500 / 150000 = 33.33 bps
  assert.equal(stack.total.bps, 33.33);
});
