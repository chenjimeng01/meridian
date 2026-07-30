#!/usr/bin/env node
// Generates the synthetic statement fixtures (5 institutions × 3 docs), their
// expected parse outputs, and the fixture household ledger — from one data
// source, so statement text and expected JSON cannot drift apart.
//
// ALL data here is fictional (see NOTICE). Outputs are committed; regeneration
// must produce byte-identical files (deterministic, no clock, no RNG).
//
// Usage: node scripts/gen-fixtures.mjs [output-dir]
//   output-dir defaults to <repo>/test/fixtures; the determinism test passes a
//   temp dir and byte-compares against the committed fixtures.
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FIX = process.argv[2] ?? join(ROOT, "test", "fixtures");

// Deterministic ULIDs for fixtures: valid Crockford base32, sequential.
const ulid = (n) => "01MER1D1AN" + String(n).padStart(16, "0");
let ulidCounter = 0;
const nextUlid = () => ulid(++ulidCounter);

const r2 = (x) => Math.round(x * 100) / 100;
const fmt = (n) =>
  n.toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------
const P1 = nextUlid(); // Eleanor Vance — US citizen, UK resident (fictional)
const P2 = nextUlid(); // Thomas Vance — UK only (fictional)

const INSTRUMENTS = {
  spOeic: { id: nextUlid(), name: "Sterling Park UK Equity Income OEIC Acc", type: "oeic", domicile: "GB", identifiers: { isin: "GB00SYNTH014", sedol: "B1SYN01" }, us_registered: false },
  atlasEtf: { id: nextUlid(), name: "Atlas Global Equity UCITS ETF", type: "ucits_etf", domicile: "IE", identifiers: { isin: "IE00SYNTH021", ticker: "ATLG" }, hmrc_reporting_fund: true, us_registered: false },
  thames: { id: nextUlid(), name: "Thames Utilities PLC Ordinary 25p", type: "equity", domicile: "GB", identifiers: { isin: "GB00SYNTH052", sedol: "B1SYN52" } },
  pioneer: { id: nextUlid(), name: "Pioneer S&P Index Fund", type: "mutual_fund_us", domicile: "US", identifiers: { isin: "US0000SYN039", ticker: "PIOSX" }, hmrc_reporting_fund: false, us_registered: true },
  amalgamated: { id: nextUlid(), name: "Amalgamated Tech Inc Common Stock", type: "equity", domicile: "US", identifiers: { isin: "US0000SYN047", ticker: "AMTK", cusip: "SYN000104" } },
  gilt: { id: nextUlid(), name: "UK Treasury Gilt 4.25% 2032", type: "bond", domicile: "GB", identifiers: { isin: "GB00SYNGLT08" } },
  continental: { id: nextUlid(), name: "Continental Rail Corp Common Stock", type: "equity", domicile: "US", identifiers: { isin: "US0000SYN062", ticker: "CRRC", cusip: "SYN000106" } },
  keystoneMmf: { id: nextUlid(), name: "Keystone Treasury Money Market Fund", type: "mmf", domicile: "US", identifiers: { isin: "US0000SYN070", ticker: "KTMXX" }, us_registered: true },
  cashGbp: { id: nextUlid(), name: "Cash (GBP)", type: "cash", identifiers: {} },
  cashUsd: { id: nextUlid(), name: "Cash (USD)", type: "cash", identifiers: {} },
};

const ACCOUNTS = {
  A1: { id: nextUlid(), token: "A1", persons: [P1], institution: "Alderbrook Platform", wrapper: "gia", jurisdiction: "UK", currency: "GBP", rawNumber: "ALD-4471902", opened: "2019-05-14" },
  A2: { id: nextUlid(), token: "A2", persons: [P1], institution: "Alderbrook Platform", wrapper: "isa", jurisdiction: "UK", currency: "GBP", rawNumber: "ALD-4471903", opened: "2019-05-14" },
  A3: { id: nextUlid(), token: "A3", persons: [P1], institution: "Beacon SIPP Trustees", wrapper: "sipp", jurisdiction: "UK", currency: "GBP", rawNumber: "BST-118834", opened: "2016-09-01" },
  A4: { id: nextUlid(), token: "A4", persons: [P1], institution: "Liberty Street Securities", wrapper: "us_brokerage", jurisdiction: "US", currency: "USD", rawNumber: "774-20991", opened: "2012-03-20" },
  A5: { id: nextUlid(), token: "A5", persons: [P1, P2], institution: "Harcourt Private Bank", wrapper: "gia", jurisdiction: "UK", currency: "GBP", rawNumber: "HPB-0055271", opened: "2021-11-02" },
  A6: { id: nextUlid(), token: "A6", persons: [P1, P2], institution: "Harcourt Private Bank", wrapper: "bank_savings", jurisdiction: "UK", currency: "GBP", rawNumber: "HPB-0055272", opened: "2021-11-02" },
};

// ---------------------------------------------------------------------------
// Document data (the single source of truth for statements + expected output)
// ---------------------------------------------------------------------------
// holding row: [instrumentKey, units, price, ccy]
const alderbrookDoc = (file, from, to, a1Rows, a1Cash, a2Rows, a2Cash) => ({
  institution: "Alderbrook Platform",
  dir: "alderbrook-platform",
  file,
  doc_type: "valuation",
  period: { from, to },
  statement_currency: "GBP",
  client: "MS ELEANOR VANCE\n14 Larkspur Mews\nLondon W1U 0XX",
  accounts: [
    { key: "A1", label: "General Investment Account", rows: a1Rows, cash: a1Cash },
    { key: "A2", label: "Stocks & Shares ISA", rows: a2Rows, cash: a2Cash },
  ],
});

const harcourtDoc = (file, from, to, rows, deposit, fxRate) => ({
  institution: "Harcourt Private Bank",
  dir: "harcourt-private-bank",
  file,
  doc_type: "valuation",
  period: { from, to },
  statement_currency: "GBP",
  client: "MS ELEANOR VANCE & MR THOMAS VANCE\n14 Larkspur Mews\nLondon W1U 0XX",
  fxRate, // GBPUSD printed on the statement
  accounts: [
    { key: "A5", label: "Discretionary Portfolio (managed by Sterling Park Wealth)", rows, cash: null },
    { key: "A6", label: "Reserve Deposit Account", rows: [], cash: deposit },
  ],
});

const mifidDoc = (file, year, avgValue, fees) => ({
  institution: "Sterling Park Wealth",
  dir: "sterling-park-wealth",
  file,
  doc_type: "mifid_costs",
  period: { from: `${year}-01-01`, to: `${year}-12-31` },
  statement_currency: "GBP",
  client: "MS ELEANOR VANCE & MR THOMAS VANCE",
  avgValue,
  accounts: [{ key: "A5", label: "Discretionary Portfolio", rows: [], cash: null, fees }],
});

const libertyDoc = (file, from, to, rows, cash, movements) => ({
  institution: "Liberty Street Securities",
  dir: "liberty-street-securities",
  file,
  doc_type: "valuation",
  period: { from, to },
  statement_currency: "USD",
  client: "ELEANOR VANCE\n14 LARKSPUR MEWS, LONDON, UNITED KINGDOM",
  accounts: [{ key: "A4", label: "Individual Brokerage", rows, cash, movements }],
});

const beaconDoc = (file, from, to, rows, cash, movements, adminFee) => ({
  institution: "Beacon SIPP Trustees",
  dir: "beacon-sipp-trustees",
  file,
  doc_type: "valuation",
  period: { from, to },
  statement_currency: "GBP",
  client: "MS ELEANOR VANCE",
  accounts: [
    {
      key: "A3",
      label: "Self-Invested Personal Pension",
      rows,
      cash,
      movements,
      fees: [{ label: "Annual scheme administration fee", category: "platform", amount: adminFee, ccy: "GBP" }],
    },
  ],
});

const DOCS = [
  alderbrookDoc("valuation-2025-12", "2025-10-01", "2025-12-31",
    [["spOeic", 12500, 2.144], ["atlasEtf", 450, 62.1], ["thames", 1800, 6.42]], 1204.5,
    [["atlasEtf", 610, 62.1], ["spOeic", 8000, 2.144]], 310.25),
  alderbrookDoc("valuation-2026-03", "2026-01-01", "2026-03-31",
    [["spOeic", 12500, 2.1965], ["atlasEtf", 450, 63.85], ["thames", 1800, 6.55]], 1210.11,
    [["atlasEtf", 640, 63.85], ["spOeic", 8000, 2.1965]], 95.4),
  alderbrookDoc("valuation-2026-06", "2026-04-01", "2026-06-30",
    [["spOeic", 12500, 2.221], ["atlasEtf", 450, 65.02], ["thames", 1800, 6.31]], 1215.8,
    [["atlasEtf", 640, 65.02], ["spOeic", 8000, 2.221]], 101.12),

  harcourtDoc("consolidated-2025-12", "2025-10-01", "2025-12-31",
    [["pioneer", 300, 145.2, "USD"], ["amalgamated", 120, 210.55, "USD"], ["gilt", 30000, 0.982, "GBP"]], 85000, 1.27),
  harcourtDoc("consolidated-2026-03", "2026-01-01", "2026-03-31",
    [["pioneer", 300, 148.9, "USD"], ["amalgamated", 120, 205.1, "USD"], ["gilt", 30000, 0.9875, "GBP"]], 85150, 1.29),
  harcourtDoc("consolidated-2026-06", "2026-04-01", "2026-06-30",
    [["pioneer", 300, 152.35, "USD"], ["amalgamated", 120, 216.4, "USD"], ["gilt", 30000, 0.991, "GBP"]], 85300, 1.28),

  mifidDoc("mifid-costs-2023", 2023, 75000, [
    { label: "Discretionary management fee", category: "platform", amount: 750, rate_bps: 100 },
    { label: "Underlying fund ongoing charges", category: "fund_ocf", amount: 180, rate_bps: 24 },
    { label: "Transaction costs", category: "transaction", amount: 95 },
    { label: "Foreign exchange spreads", category: "fx_spread", amount: 40 },
    { label: "Incidental costs", category: "incidental", amount: 15 },
  ]),
  mifidDoc("mifid-costs-2024", 2024, 78500, [
    { label: "Discretionary management fee", category: "platform", amount: 785, rate_bps: 100 },
    { label: "Underlying fund ongoing charges", category: "fund_ocf", amount: 190, rate_bps: 24 },
    { label: "Transaction costs", category: "transaction", amount: 110 },
    { label: "Foreign exchange spreads", category: "fx_spread", amount: 45 },
  ]),
  mifidDoc("mifid-costs-2025", 2025, 82000, [
    { label: "Discretionary management fee", category: "platform", amount: 820, rate_bps: 100 },
    { label: "Underlying fund ongoing charges", category: "fund_ocf", amount: 198, rate_bps: 24 },
    { label: "Transaction costs", category: "transaction", amount: 88 },
    { label: "Foreign exchange spreads", category: "fx_spread", amount: 52 },
  ]),

  libertyDoc("statement-2026-04", "2026-04-01", "2026-04-30",
    [["amalgamated", 85, 202.4], ["continental", 55, 96.3], ["keystoneMmf", 12400, 1]], 152.4,
    [{ date: "2026-04-15", type: "dividend", instrument: "amalgamated", amount: 34.2, description: "AMTK cash dividend" }]),
  libertyDoc("statement-2026-05", "2026-05-01", "2026-05-31",
    [["amalgamated", 85, 208.11], ["continental", 60, 97.85], ["keystoneMmf", 12410, 1]], 152.4,
    [{ date: "2026-05-08", type: "buy", instrument: "continental", units: 5, amount: 485.5, description: "Bought 5 CRRC @ 97.10" }]),
  libertyDoc("statement-2026-06", "2026-06-01", "2026-06-30",
    [["amalgamated", 85, 216.4], ["continental", 60, 98], ["keystoneMmf", 12451.15, 1]], 152.4,
    [{ date: "2026-06-30", type: "interest", instrument: "keystoneMmf", amount: 41.15, description: "KTMXX dividend reinvested" }]),

  beaconDoc("annual-2024", "2023-04-06", "2024-04-05",
    [["atlasEtf", 900, 55.2], ["spOeic", 15000, 1.985]], 2150,
    [
      { date: "2024-04-05", type: "contribution", amount: 12000, description: "Employer contributions (year total)" },
      { date: "2024-04-05", type: "contribution", amount: 8000, description: "Member contributions incl. tax relief (year total)" },
    ], 250),
  beaconDoc("annual-2025", "2024-04-06", "2025-04-05",
    [["atlasEtf", 1050, 59.4], ["spOeic", 16500, 2.071]], 1890,
    [
      { date: "2025-04-05", type: "contribution", amount: 12000, description: "Employer contributions (year total)" },
      { date: "2025-04-05", type: "contribution", amount: 8000, description: "Member contributions incl. tax relief (year total)" },
    ], 255),
  beaconDoc("annual-2026", "2025-04-06", "2026-04-05",
    [["atlasEtf", 1150, 63.9], ["spOeic", 17200, 2.201]], 2305,
    [
      { date: "2026-04-05", type: "contribution", amount: 12000, description: "Employer contributions (year total)" },
      { date: "2026-04-05", type: "contribution", amount: 10000, description: "Member contributions incl. tax relief (year total)" },
    ], 260),
];

// ---------------------------------------------------------------------------
// Statement text rendering (synthetic, pre-redaction: fake names/numbers)
// ---------------------------------------------------------------------------
function renderStatement(doc) {
  const L = [];
  const rule = "=".repeat(72);
  L.push(rule, doc.institution.toUpperCase(), rule, "");
  L.push(doc.doc_type === "mifid_costs" ? "ANNUAL COSTS & CHARGES DISCLOSURE (MiFID II ex-post)" : "VALUATION STATEMENT");
  L.push(`Period: ${doc.period.from} to ${doc.period.to}`, `Statement currency: ${doc.statement_currency}`, "");
  L.push(doc.client, "");
  if (doc.fxRate) L.push(`Exchange rate applied: GBP/USD ${doc.fxRate.toFixed(4)}`, "");

  for (const acct of doc.accounts) {
    const a = ACCOUNTS[acct.key];
    L.push("-".repeat(72), `${acct.label}   Account no: ${a.rawNumber}`, "-".repeat(72));
    if (acct.rows.length) {
      L.push("Holding                                     Units        Price       Value");
      let total = 0;
      for (const [key, units, price, ccy] of acct.rows) {
        const inst = INSTRUMENTS[key];
        const value = r2(units * price);
        const cur = ccy ?? doc.statement_currency;
        if (cur === doc.statement_currency || !doc.fxRate) total += value;
        else total += r2(value / doc.fxRate);
        const idTag = inst.identifiers.isin ?? inst.identifiers.ticker ?? "";
        L.push(`${inst.name.padEnd(40)} ${String(units).padStart(9)} ${price.toFixed(4).padStart(12)} ${(cur === "USD" ? "$" : "£") + fmt(value)}`.trimEnd());
        if (idTag) L.push(`  ${inst.identifiers.isin ? "ISIN" : "Ticker"}: ${idTag}`);
      }
      if (acct.cash != null) {
        L.push(`Cash balance ${" ".repeat(48)}${(doc.statement_currency === "USD" ? "$" : "£") + fmt(acct.cash)}`);
        total += acct.cash;
      }
      L.push(`TOTAL (${doc.statement_currency}) ${" ".repeat(46)}${(doc.statement_currency === "USD" ? "$" : "£") + fmt(r2(total))}`);
    } else if (acct.cash != null) {
      L.push(`Balance: £${fmt(acct.cash)}`);
    }
    if (acct.fees?.length) {
      L.push("", "Charges for the period:");
      let feeTotal = 0;
      for (const f of acct.fees) {
        feeTotal += f.amount;
        L.push(`  ${f.label.padEnd(44)} £${fmt(f.amount)}${f.rate_bps ? `  (${(f.rate_bps / 100).toFixed(2)}% p.a.)` : ""}`);
      }
      L.push(`  TOTAL COSTS AND CHARGES ${" ".repeat(20)} £${fmt(r2(feeTotal))}`);
      if (doc.avgValue) L.push(`  Average portfolio value over period: £${fmt(doc.avgValue)}`);
    }
    if (acct.movements?.length) {
      L.push("", "Activity during the period:");
      for (const m of acct.movements) {
        L.push(`  ${m.date}  ${m.type.toUpperCase().padEnd(13)} ${(doc.statement_currency === "USD" ? "$" : "£") + fmt(m.amount)}  ${m.description}`);
      }
    }
    L.push("");
  }
  L.push(rule, "SYNTHETIC FIXTURE — fictional institution, client and holdings (see NOTICE).", rule, "");
  return L.join("\n");
}

// ---------------------------------------------------------------------------
// Expected parse output (conforms to schema/parse-output.schema.json)
// ---------------------------------------------------------------------------
// A holding row prints exactly one identifier line (ISIN preferred, else
// ticker); the expected extraction may only contain what the statement shows —
// enrichment to full identifier sets happens at the match/accept stage.
const visibleIdentifiers = (inst) =>
  inst.identifiers.isin
    ? { isin: inst.identifiers.isin }
    : inst.identifiers.ticker
      ? { ticker: inst.identifiers.ticker }
      : {};

function renderExpected(doc) {
  return {
    schema_version: "0.1",
    source: {
      institution: doc.institution,
      doc_type: doc.doc_type,
      period: doc.period,
      statement_currency: doc.statement_currency,
      ...(doc.fxRate ? { fx_rates: [{ pair: "GBPUSD", rate: doc.fxRate, confidence: 0.98 }] } : {}),
    },
    accounts: doc.accounts.map((acct) => {
      const a = ACCOUNTS[acct.key];
      const out = {
        account_token: a.token,
        wrapper_hint: a.wrapper,
        currency: a.currency,
        confidence: 0.98,
      };
      if (acct.rows.length) {
        out.holdings = acct.rows.map(([key, units, price, ccy]) => {
          const inst = INSTRUMENTS[key];
          const cur = ccy ?? doc.statement_currency;
          return {
            name: inst.name,
            identifiers: visibleIdentifiers(inst),
            units,
            price: { amount: price, currency: cur },
            value: { amount: r2(units * price), currency: cur },
            confidence: 0.98,
          };
        });
      }
      if (acct.cash != null) out.cash_balance = { amount: acct.cash, currency: doc.statement_currency, confidence: 0.98 };
      if (acct.fees?.length) {
        out.fees = acct.fees.map((f) => ({
          label: f.label,
          category: f.category,
          amount: { amount: f.amount, currency: doc.statement_currency },
          ...(f.rate_bps ? { rate_bps: f.rate_bps } : {}),
          period: doc.period,
          confidence: 0.97,
        }));
      }
      if (acct.movements?.length) {
        // No units field: the statement's activity lines carry units only in
        // free text; the extractor must not invent structure it cannot see.
        out.movements = acct.movements.map((m) => ({
          date: m.date,
          type: m.type,
          description: m.description,
          amount: { amount: m.amount, currency: doc.statement_currency },
          confidence: 0.97,
        }));
      }
      return out;
    }),
    overall_confidence: 0.97,
  };
}

// ---------------------------------------------------------------------------
// Write statements + expected, collecting sha256 for the ledger's documents[]
// ---------------------------------------------------------------------------
// Fixed timestamps: this fixture household represents one operator session.
const PARSED_AT = "2026-07-30T11:00:00Z";
const ACCEPTED_AT = "2026-07-30T12:00:00Z";
const OPERATOR = "JC";

const documents = [];
const acceptances = [];
const holdings = [];
const transactions = [];
const pricePoints = new Map(); // instrumentKey -> [{date, price, source}]

for (const doc of DOCS) {
  const text = renderStatement(doc);
  const txtPath = join(FIX, "statements", doc.dir, `${doc.file}.txt`);
  const expPath = join(FIX, "expected", doc.dir, `${doc.file}.json`);
  mkdirSync(dirname(txtPath), { recursive: true });
  mkdirSync(dirname(expPath), { recursive: true });
  writeFileSync(txtPath, text);
  writeFileSync(expPath, JSON.stringify(renderExpected(doc), null, 2) + "\n");

  const docId = nextUlid();
  const runId = `RUN-${String(documents.length + 1).padStart(2, "0")}`;
  documents.push({
    id: docId,
    filename: `${doc.dir}/${doc.file}.txt`,
    sha256: createHash("sha256").update(text).digest("hex"),
    institution: doc.institution,
    doc_type: doc.doc_type,
    period: doc.period,
    parsed_at: PARSED_AT,
    accepted_at: ACCEPTED_AT,
    parse_run_ids: [runId],
  });
  const acceptanceLines = [];

  for (const acct of doc.accounts) {
    const a = ACCOUNTS[acct.key];
    for (const [key, units, price, ccy] of acct.rows) {
      const inst = INSTRUMENTS[key];
      const cur = ccy ?? doc.statement_currency;
      holdings.push({
        account_id: a.id,
        instrument_id: inst.id,
        asof: doc.period.to,
        units,
        value: { amount: r2(units * price), currency: cur },
        source_document_id: docId,
      });
      if (!pricePoints.has(key)) pricePoints.set(key, []);
      pricePoints.get(key).push({ date: doc.period.to, price: { amount: price, currency: cur }, source: "statement" });
      acceptanceLines.push({ kind: "holding", account_token: a.token, ref: inst.name, action: "accepted", instrument_id: inst.id });
    }
    if (acct.cash != null && doc.doc_type !== "mifid_costs") {
      const cashInst = doc.statement_currency === "USD" ? INSTRUMENTS.cashUsd : INSTRUMENTS.cashGbp;
      holdings.push({
        account_id: a.id,
        instrument_id: cashInst.id,
        asof: doc.period.to,
        units: acct.cash,
        value: { amount: acct.cash, currency: doc.statement_currency },
        source_document_id: docId,
      });
      acceptanceLines.push({ kind: "cash", account_token: a.token, ref: cashInst.name, action: "accepted" });
    }
    for (const f of acct.fees ?? []) {
      acceptanceLines.push({ kind: "fee", account_token: a.token, ref: f.label, action: "accepted" });
    }
    for (const m of acct.movements ?? []) {
      transactions.push({
        account_id: a.id,
        date: m.date,
        type: m.type,
        instrument_id: m.instrument ? INSTRUMENTS[m.instrument].id : null,
        ...(m.units ? { units: m.units } : {}),
        gross: { amount: m.amount, currency: doc.statement_currency },
        net: { amount: m.amount, currency: doc.statement_currency },
        source_document_id: docId,
      });
      acceptanceLines.push({ kind: "movement", account_token: a.token, ref: `${m.date} ${m.type}`, action: "accepted" });
    }
  }

  acceptances.push({
    id: nextUlid(),
    document_id: docId,
    parse_run_id: runId,
    accepted_at: ACCEPTED_AT,
    operator_initials: OPERATOR,
    lines: acceptanceLines,
  });
}

// ---------------------------------------------------------------------------
// Fixture household ledger
// ---------------------------------------------------------------------------
const dataAsof = (accountId) =>
  holdings.filter((h) => h.account_id === accountId).map((h) => h.asof).sort().at(-1);

const ledger = {
  schema_version: "0.1",
  household: {
    id: nextUlid(),
    base_currency: "GBP",
    secondary_currency: "USD",
    persons: [
      {
        id: P1,
        display_token: "P1",
        tax_profile: {
          uk_resident: true,
          uk_domicile_status: "ltr_flag",
          us_person: true,
          us_person_basis: "citizen",
          state_exposure: "NY",
          treaty_positions: ["uk_us_dta_pension_art17_18"],
        },
      },
      {
        id: P2,
        display_token: "P2",
        tax_profile: { uk_resident: true, uk_domicile_status: "ltr_flag", us_person: false },
      },
    ],
  },
  accounts: Object.values(ACCOUNTS).map((a) => ({
    id: a.id,
    person_ids: a.persons,
    institution: a.institution,
    account_token: a.token,
    wrapper: a.wrapper,
    wrapper_jurisdiction: a.jurisdiction,
    custody_currency: a.currency,
    opened: a.opened,
    data_asof: dataAsof(a.id) ?? "2026-06-30",
  })),
  instruments: Object.entries(INSTRUMENTS).map(([key, inst]) => ({
    id: inst.id,
    identifiers: inst.identifiers,
    name: inst.name,
    type: inst.type,
    ...(inst.domicile ? { domicile: inst.domicile } : {}),
    ...(inst.hmrc_reporting_fund !== undefined ? { hmrc_reporting_fund: inst.hmrc_reporting_fund } : {}),
    ...(inst.us_registered !== undefined ? { us_registered: inst.us_registered } : {}),
    pfic_status: "not_assessed",
    prices: pricePoints.get(key) ?? [],
  })),
  holdings,
  transactions,
  documents,
  acceptances,
  fx_rates: [
    { date: "2025-12-31", pair: "GBPUSD", rate: 1.27, source: "statement:harcourt-private-bank/consolidated-2025-12" },
    { date: "2026-03-31", pair: "GBPUSD", rate: 1.29, source: "statement:harcourt-private-bank/consolidated-2026-03" },
    { date: "2026-06-30", pair: "GBPUSD", rate: 1.28, source: "statement:harcourt-private-bank/consolidated-2026-06" },
  ],
};

mkdirSync(join(FIX, "ledger"), { recursive: true });
writeFileSync(join(FIX, "ledger", "household-usuk.json"), JSON.stringify(ledger, null, 2) + "\n");

console.log(`Wrote ${DOCS.length} statements + expected outputs, ledger with ${holdings.length} holdings, ${transactions.length} transactions, ${documents.length} documents.`);
