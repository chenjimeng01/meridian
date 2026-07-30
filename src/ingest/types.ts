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
  cash_balance?: Money & { confidence: number };
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
    fx_rates?: { pair: string; rate: number; date?: string; confidence?: number }[];
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
  /** When this parse run executed; injected, never read from the clock in src/. */
  created_at: string;
  redactedText: string;
  output: ParseOutput;
  matches: MatchResult[];
}

/**
 * Operator confirmation of an instrument's classifying metadata (SPEC §7.1).
 * The PFIC cascade refuses to run on ingest-inferred metadata, so without this
 * every instrument routes to `needs_classification` and a real ledger produces
 * no PFIC flags at all. Confirming is therefore an operator action, logged
 * like any other decision — never something the parser may assert for itself.
 */
export interface MetadataConfirmation {
  type?: string;
  domicile?: string;
  /** '40 Act registered — not knowable from a statement, so it must be confirmed. */
  us_registered?: boolean;
  hmrc_reporting_fund?: boolean;
}

/** One operator decision on one extracted line (SPEC §5.6). */
export interface LineDecision {
  action: "accept" | "reject";
  /** Operator corrections to the extracted figures; presence records the line as "edited". */
  edits?: { units?: number; value?: Money; book_cost?: Money; amount?: Money; date?: string };
  /** Confirms one of the fuzzy candidates proposed for this holding (SPEC §5.4). */
  instrumentId?: string;
  /** Confirms the instrument's classifying metadata, unlocking the §7.1 cascade. */
  confirmMetadata?: MetadataConfirmation;
  note?: string;
}

export interface LineRef {
  kind: "holding" | "cash" | "fee" | "movement";
  accountToken: string;
  index: number;
  /** Human-readable label for the acceptance log. */
  ref: string;
  match?: MatchResult;
  holding?: ParseHolding;
  fee?: ParseFee;
  movement?: ParseMovement;
  cash?: Money;
}

export interface AcceptOptions {
  /** ISO timestamp of the acceptance session; injected at the CLI boundary. */
  acceptedAt: string;
  operatorInitials: string;
  /** Per-line operator decision. Omitted means accept every line unchanged. */
  decide?: (line: LineRef) => LineDecision;
}

export interface AcceptanceLine {
  kind: string;
  account_token: string;
  ref: string;
  action: "accepted" | "edited" | "rejected";
  instrument_id?: string;
  note?: string;
}

export type IdFactory = () => string;

// The canonical ledger, mirroring schema/ledger.schema.json (SPEC §4). The
// schema remains the source of truth and is what ajv enforces; these types
// exist so the engine gets compile-time protection over the same shape.

export interface TaxProfile {
  uk_resident: boolean;
  uk_domicile_status?: "ltr_flag" | "not_ltr" | "unknown";
  us_person: boolean;
  us_person_basis?: "citizen" | "green_card" | "substantial_presence";
  state_exposure?: string;
  treaty_positions?: string[];
}

export interface Person {
  id: string;
  display_token: string;
  tax_profile: TaxProfile;
}

export interface Account {
  id: string;
  person_ids: string[];
  institution: string;
  account_token: string;
  wrapper: string;
  wrapper_jurisdiction: "UK" | "US" | "OTHER";
  custody_currency: string;
  opened: string | null;
  data_asof: string;
}

export interface InstrumentPrice {
  date: string;
  price: Money;
  source: "statement" | "feed" | "manual";
}

export interface Instrument {
  id: string;
  identifiers: { isin?: string; sedol?: string; ticker?: string; cusip?: string };
  name: string;
  type: string;
  domicile?: string;
  hmrc_reporting_fund?: boolean;
  us_registered?: boolean;
  pfic_status?: "not_assessed" | "not_pfic" | "pfic" | "needs_classification";
  /** Only true once an operator has confirmed type/domicile/registration (SPEC §7.1). */
  metadata_confirmed?: boolean;
  needs_review?: boolean;
  prices: InstrumentPrice[];
}

export interface Holding {
  account_id: string;
  instrument_id: string;
  asof: string;
  units: number;
  book_cost?: Money;
  value: Money;
  source_document_id?: string;
  source?: "manual";
  operator_initials?: string;
}

export interface Transaction {
  account_id: string;
  date: string;
  type: string;
  instrument_id: string | null;
  /** As disclosed on the source document. */
  label?: string;
  /** SPEC §6.3 cost category, carried through from the parse output. */
  category?: string;
  units?: number;
  gross?: Money;
  fees?: Money;
  net?: Money;
  source_document_id?: string;
  source?: "manual";
  operator_initials?: string;
}

export interface LedgerDocument {
  id: string;
  filename: string;
  sha256: string;
  institution: string;
  doc_type: string;
  period: { from: string; to: string };
  parsed_at?: string;
  accepted_at?: string;
  parse_run_ids: string[];
}

export interface Acceptance {
  id: string;
  document_id: string;
  parse_run_id: string;
  accepted_at: string;
  operator_initials: string;
  lines: AcceptanceLine[];
}

export interface LedgerFxRate {
  date: string;
  pair: string;
  rate: number;
  source: string;
}

export interface Ledger {
  schema_version: "0.1";
  household: {
    id: string;
    base_currency: string;
    secondary_currency?: string;
    persons: Person[];
  };
  accounts: Account[];
  instruments: Instrument[];
  holdings: Holding[];
  transactions: Transaction[];
  documents: LedgerDocument[];
  acceptances: Acceptance[];
  fx_rates: LedgerFxRate[];
}
