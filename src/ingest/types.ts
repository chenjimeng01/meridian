// Shared types for the ingestion pipeline. These mirror the two committed
// JSON Schemas; the schemas remain the source of truth (ajv-enforced).

export interface Money {
  amount: number;
  currency: string;
}

export interface ParseHolding {
  name: string;
  identifiers: { isin?: string; sedol?: string; ticker?: string; cusip?: string };
  units: number;
  price?: Money;
  value: Money;
  book_cost?: Money;
  confidence: number;
}

export interface ParseFee {
  label: string;
  category: string;
  amount: Money;
  rate_bps?: number;
  period?: { from: string; to: string };
  confidence: number;
}

export interface ParseMovement {
  date: string;
  type: string;
  description?: string;
  units?: number;
  amount: Money;
  confidence: number;
}

export interface ParseAccount {
  account_token: string;
  wrapper_hint?: string;
  currency?: string;
  confidence: number;
  holdings?: ParseHolding[];
  cash_balance?: Money;
  fees?: ParseFee[];
  movements?: ParseMovement[];
}

export interface ParseOutput {
  schema_version: "0.1";
  source: {
    institution: string;
    doc_type: string;
    period: { from: string; to: string };
    statement_currency: string;
    fx_rates?: { pair: string; rate: number; date?: string }[];
  };
  accounts: ParseAccount[];
  overall_confidence: number;
  warnings?: string[];
}

export interface MatchResult {
  accountIndex: number;
  holdingIndex: number;
  status: "matched" | "candidates" | "new";
  instrumentId?: string;
  candidates?: string[];
}

export interface ParseRun {
  id: string;
  filename: string;
  sha256: string;
  redactedText: string;
  output: ParseOutput;
  matches: MatchResult[];
}

export type IdFactory = () => string;

export interface Ledger {
  schema_version: "0.1";
  household: {
    id: string;
    base_currency: string;
    secondary_currency?: string;
    persons: { id: string; display_token: string; tax_profile: Record<string, unknown> }[];
  };
  accounts: any[];
  instruments: any[];
  holdings: any[];
  transactions: any[];
  documents: any[];
  fx_rates: any[];
}
