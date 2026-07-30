// Module 2 — deterministic analytics engine (SPEC §6).
//
// Everything here is a pure function of (ledger, params, options). No I/O, no
// system clock, no randomness: the valuation date is always passed in. An LLM
// never computes any number produced by this module (SPEC §2.1).
export {
  convert,
  toCurrency,
  findRate,
  roundHalfEven,
  FxUnavailableError,
  type Money,
  type FxRate,
  type FxResult,
  type FxContext,
} from "./fx.ts";

export {
  consolidate,
  latestHoldings,
  type ConsolidationResult,
  type ConsolidateInput,
  type DualMoney,
  type Slice,
} from "./consolidate.ts";

export {
  timeWeightedReturn,
  modifiedDietz,
  chainLink,
  xirr,
  realReturn,
  daysBetween,
  type ReturnResult,
  type ReturnMethod,
  type Valuation,
  type Flow,
} from "./performance.ts";

export {
  costStack,
  compoundingDrag,
  type CostStackResult,
  type CostStackInput,
  type CostLine,
  type CompoundingDragResult,
} from "./cost.ts";

export { assessRisk, type RiskResult, type RiskInput, type ConcentrationFlag } from "./risk.ts";
