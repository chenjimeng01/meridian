// Deterministic extractor for the synthetic fixture statement layout — the
// offline/test path of the pipeline. Real-world documents go through the LLM
// extractor (extract-llm.ts); both produce the same parse-output shape and are
// validated against schema/parse-output.schema.json.
//
// Contract: parser output must byte-match test/fixtures/expected/** exactly
// (SPEC §5 Phase 2 acceptance). It may only extract what the statement shows.
import type { ParseAccount, ParseFee, ParseHolding, ParseMovement, ParseOutput } from "./types.ts";

const INSTITUTIONS: Record<string, string> = {
  "ALDERBROOK PLATFORM": "Alderbrook Platform",
  "HARCOURT PRIVATE BANK": "Harcourt Private Bank",
  "STERLING PARK WEALTH": "Sterling Park Wealth",
  "LIBERTY STREET SECURITIES": "Liberty Street Securities",
  "BEACON SIPP TRUSTEES": "Beacon SIPP Trustees",
};

const WRAPPER_HINTS: [RegExp, string][] = [
  [/ISA/, "isa"],
  [/Investment Account/, "gia"],
  [/Pension/, "sipp"],
  [/Brokerage/, "us_brokerage"],
  [/Deposit/, "bank_savings"],
  [/Discretionary Portfolio/, "gia"],
];

const FEE_CATEGORIES: [RegExp, string][] = [
  [/management|administration/i, "platform"],
  [/ongoing charges|\bocf\b/i, "fund_ocf"],
  [/transaction/i, "transaction"],
  [/foreign exchange|\bfx\b/i, "fx_spread"],
  [/incidental/i, "incidental"],
];

const CONF = { account: 0.98, holding: 0.98, fee: 0.97, movement: 0.97, overall: 0.97 };

const HOLDING_RE = /^(.+?)\s{2,}([\d.]+)\s+(\d+\.\d{4})\s+([$£])([\d,.]+)$/;
const ID_RE = /^\s{2}(ISIN|Ticker): (\S+)$/;
const CASH_TABLE_RE = /^Cash balance\s{2,}([$£])([\d,.]+)$/;
const CASH_BARE_RE = /^Balance: ([$£])([\d,.]+)$/;
const FEE_RE = /^\s{2}(.+?)\s{2,}£([\d,.]+)(?:\s{2}\((\d+(?:\.\d+)?)% p\.a\.\))?$/;
const MOVEMENT_RE = /^\s{2}(\d{4}-\d{2}-\d{2})\s{2}([A-Z_]+)\s+([$£])([\d,.]+)\s{2}(.+)$/;
const SECTION_HEAD_RE = /^(.+?)\s{3}Account no: (\S+)$/;

const num = (s: string) => Number(s.replace(/,/g, ""));
const symCurrency = (sym: string) => (sym === "$" ? "USD" : "GBP");
const isRule = (line: string, ch: string) => line.length >= 10 && [...line].every((c) => c === ch);

function classify(label: string): string {
  for (const [re, wrapper] of WRAPPER_HINTS) if (re.test(label)) return wrapper;
  return "unknown";
}

function feeCategory(label: string): string {
  for (const [re, cat] of FEE_CATEGORIES) if (re.test(label)) return cat;
  return "other";
}

export function parseFixtureStatement(redactedText: string): ParseOutput {
  const lines = redactedText.split("\n");

  let institution = "Unknown";
  let docType = "valuation";
  let period = { from: "", to: "" };
  let currency = "GBP";
  let fxRate: number | undefined;

  for (const line of lines) {
    if (INSTITUTIONS[line]) institution = INSTITUTIONS[line];
    if (line.includes("MiFID II ex-post")) docType = "mifid_costs";
    const p = line.match(/^Period: (\d{4}-\d{2}-\d{2}) to (\d{4}-\d{2}-\d{2})$/);
    if (p) period = { from: p[1]!, to: p[2]! };
    const c = line.match(/^Statement currency: ([A-Z]{3})$/);
    if (c) currency = c[1]!;
    const fx = line.match(/^Exchange rate applied: GBP\/USD ([\d.]+)$/);
    if (fx) fxRate = Number(fx[1]);
  }

  interface Section {
    token: string;
    label: string;
    holdings: ParseHolding[];
    cash?: number;
    cashSym?: string;
    fees: ParseFee[];
    movements: ParseMovement[];
  }
  const sections: Section[] = [];
  let current: Section | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const head = line.match(SECTION_HEAD_RE);
    if (head && i > 0 && isRule(lines[i - 1]!, "-")) {
      current = { token: head[2]!, label: head[1]!, holdings: [], fees: [], movements: [] };
      sections.push(current);
      i++; // skip the closing dash rule
      continue;
    }
    if (!current || isRule(line, "=")) continue;

    const idLine = line.match(ID_RE);
    if (idLine) {
      const last = current.holdings[current.holdings.length - 1];
      if (last) {
        if (idLine[1] === "ISIN") last.identifiers.isin = idLine[2]!;
        else last.identifiers.ticker = idLine[2]!;
      }
      continue;
    }
    const move = line.match(MOVEMENT_RE);
    if (move) {
      current.movements.push({
        date: move[1]!,
        type: move[2]!.toLowerCase(),
        description: move[5]!,
        amount: { amount: num(move[4]!), currency: symCurrency(move[3]!) },
        confidence: CONF.movement,
      });
      continue;
    }
    const cashTable = line.match(CASH_TABLE_RE) ?? line.match(CASH_BARE_RE);
    if (cashTable) {
      current.cash = num(cashTable[2]!);
      current.cashSym = cashTable[1]!;
      continue;
    }
    if (line.startsWith("TOTAL (")) continue;
    const fee = line.match(FEE_RE);
    if (fee && !fee[1]!.startsWith("TOTAL")) {
      current.fees.push({
        label: fee[1]!,
        category: feeCategory(fee[1]!),
        amount: { amount: num(fee[2]!), currency },
        ...(fee[3] ? { rate_bps: Math.round(Number(fee[3]) * 100) } : {}),
        period,
        confidence: CONF.fee,
      });
      continue;
    }
    const holding = line.match(HOLDING_RE);
    if (holding && !line.startsWith("Holding ")) {
      current.holdings.push({
        name: holding[1]!,
        identifiers: {},
        units: num(holding[2]!),
        price: { amount: num(holding[3]!), currency: symCurrency(holding[4]!) },
        value: { amount: num(holding[5]!), currency: symCurrency(holding[4]!) },
        confidence: CONF.holding,
      });
    }
  }

  const accounts: ParseAccount[] = sections.map((s) => {
    const acct: ParseAccount = {
      account_token: s.token,
      wrapper_hint: classify(s.label),
      currency,
      confidence: CONF.account,
    };
    if (s.holdings.length) acct.holdings = s.holdings;
    if (s.cash !== undefined) acct.cash_balance = { amount: s.cash, currency: symCurrency(s.cashSym!) };
    if (s.fees.length) acct.fees = s.fees;
    if (s.movements.length) acct.movements = s.movements;
    return acct;
  });

  return {
    schema_version: "0.1",
    source: {
      institution,
      doc_type: docType,
      period,
      statement_currency: currency,
      ...(fxRate !== undefined ? { fx_rates: [{ pair: "GBPUSD", rate: fxRate }] } : {}),
    },
    accounts,
    overall_confidence: CONF.overall,
  };
}

export function serializeParseOutput(output: ParseOutput): string {
  return JSON.stringify(output, null, 2) + "\n";
}
