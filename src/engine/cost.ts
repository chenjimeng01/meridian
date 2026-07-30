// Cost stack (SPEC §6.3). This is the screen the product is judged on, so the
// rule is absolute: every number reconciles to a source document, to the
// penny. A cost line with no attribution is refused rather than shown.
import { roundHalfEven, type Money } from "./fx.ts";

export interface CostLine {
  label: string;
  category: string;
  amount: Money;
  rateBps?: number;
  sourceDocument?: string;
  accountToken?: string;
}

export interface CostTotal {
  amount: Money;
  /** Basis points of the average value the cost was charged on. */
  bps: number;
}

export interface CostStackResult {
  lines: CostLine[];
  byCategory: Record<string, CostTotal>;
  byAccount: Record<string, CostTotal>;
  total: CostTotal;
  averageValue: Money;
}

export interface CostStackInput {
  accounts: {
    accountToken: string;
    averageValue: Money;
    fees: CostLine[];
  }[];
  baseCurrency: string;
}

const BPS_DECIMALS = 2;
const MONEY_DECIMALS = 2;

const bps = (amount: number, base: number): number =>
  base === 0 ? 0 : roundHalfEven((amount / base) * 10_000, BPS_DECIMALS);

export function costStack(input: CostStackInput): CostStackResult {
  const lines: CostLine[] = [];
  const byCategory: Record<string, CostTotal> = {};
  const byAccount: Record<string, CostTotal> = {};
  let totalAmount = 0;
  let totalBase = 0;

  for (const account of input.accounts) {
    if (account.averageValue.currency !== input.baseCurrency) {
      throw new Error(
        `costStack: account ${account.accountToken} average value is in ${account.averageValue.currency}, expected ${input.baseCurrency} — convert before aggregating`
      );
    }
    let accountAmount = 0;
    for (const fee of account.fees) {
      if (!fee.sourceDocument) {
        throw new Error(
          `costStack: cost line "${fee.label}" on ${account.accountToken} has no source document — §6.3 requires every number to be traceable`
        );
      }
      if (fee.amount.currency !== input.baseCurrency) {
        throw new Error(
          `costStack: cost line "${fee.label}" is in ${fee.amount.currency}, expected ${input.baseCurrency} — convert before aggregating`
        );
      }
      const line: CostLine = { ...fee, accountToken: account.accountToken };
      lines.push(line);
      accountAmount = roundHalfEven(accountAmount + fee.amount.amount, MONEY_DECIMALS);

      const existing = byCategory[fee.category];
      const categoryAmount = roundHalfEven((existing?.amount.amount ?? 0) + fee.amount.amount, MONEY_DECIMALS);
      byCategory[fee.category] = {
        amount: { amount: categoryAmount, currency: input.baseCurrency },
        bps: 0, // filled once the aggregate base is known
      };
    }
    byAccount[account.accountToken] = {
      amount: { amount: accountAmount, currency: input.baseCurrency },
      bps: bps(accountAmount, account.averageValue.amount),
    };
    totalAmount = roundHalfEven(totalAmount + accountAmount, MONEY_DECIMALS);
    totalBase = roundHalfEven(totalBase + account.averageValue.amount, MONEY_DECIMALS);
  }

  for (const category of Object.keys(byCategory)) {
    byCategory[category]!.bps = bps(byCategory[category]!.amount.amount, totalBase);
  }

  return {
    lines,
    byCategory,
    byAccount,
    total: { amount: { amount: totalAmount, currency: input.baseCurrency }, bps: bps(totalAmount, totalBase) },
    averageValue: { amount: totalBase, currency: input.baseCurrency },
  };
}

export interface CompoundingDragInput {
  startingValue: Money;
  /** Gross growth assumption, e.g. 0.05. Supplied by the operator, not assumed here. */
  grossGrowthRate: number;
  /** Total ongoing cost as a fraction, e.g. 0.0125 for 125bps. */
  annualFeeRate: number;
  years: number;
}

export interface CompoundingDragResult {
  grossTerminal: Money;
  netTerminal: Money;
  drag: Money;
  dragAsShareOfGross: number;
  years: number;
  /** The starting value and rates actually used, so nothing re-derives them. */
  startingValue: Money;
  grossGrowthRate: number;
  annualFeeRate: number;
  assumption: string;
}

/**
 * The cost of costs (SPEC §6.3): what the fee compounds to over the horizon.
 * Modelled as growth at the gross rate versus growth at the gross rate less
 * the fee — the standard presentation, and the assumption is stated so the
 * reader knows the fee is treated as a constant annual drag on the whole pot.
 */
export function compoundingDrag(input: CompoundingDragInput): CompoundingDragResult {
  if (input.years <= 0) throw new Error("compoundingDrag: years must be positive");
  if (input.annualFeeRate < 0) throw new Error("compoundingDrag: fee rate cannot be negative");

  const currency = input.startingValue.currency;
  const grossFactor = Math.pow(1 + input.grossGrowthRate, input.years);
  const netFactor = Math.pow(1 + input.grossGrowthRate - input.annualFeeRate, input.years);
  const grossTerminal = input.startingValue.amount * grossFactor;
  const netTerminal = input.startingValue.amount * netFactor;

  return {
    grossTerminal: { amount: roundHalfEven(grossTerminal, MONEY_DECIMALS), currency },
    netTerminal: { amount: roundHalfEven(netTerminal, MONEY_DECIMALS), currency },
    drag: { amount: roundHalfEven(grossTerminal - netTerminal, MONEY_DECIMALS), currency },
    dragAsShareOfGross: grossTerminal === 0 ? 0 : (grossTerminal - netTerminal) / grossTerminal,
    years: input.years,
    startingValue: input.startingValue,
    grossGrowthRate: input.grossGrowthRate,
    annualFeeRate: input.annualFeeRate,
    assumption: `growth at ${(input.grossGrowthRate * 100).toFixed(2)}% a year less an ongoing charge of ${(input.annualFeeRate * 100).toFixed(2)}% applied to the whole portfolio each year, with no contributions or withdrawals`,
  };
}
