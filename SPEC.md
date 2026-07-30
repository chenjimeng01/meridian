# MERIDIAN — Build Specification v0.1
## Cross-Border Wealth Intelligence Platform (working title)

**Purpose of this document:** A complete build specification for Claude Code. Work through it phase by phase. Each phase has acceptance criteria; do not begin a phase until the previous phase's criteria pass. This is a personal-time, clean-sheet project: no employer code, data, or documents may be referenced or imported. Test data only until a regulatory and data-protection wrapper exists.

---

## 1. Product definition

**One line:** A statement-based total-wealth intelligence platform that consolidates every account a sophisticated client holds, computes honest performance/cost/risk analytics, and treats US-connected (dual UK/US) clients as first-class citizens — delivered mobile-first.

**The single job of v0:** A client (or their adviser) uploads their custodian/platform/bank statements as PDFs; the system parses them into a canonical wealth ledger, a human confirms the parse, and the client receives a mobile-first consolidated report showing: everything they own, in one currency of their choosing, what it really costs, how it really performed, and — if they are a US person — every tax landmine in the portfolio (PFICs, situs exposure, wrapper conflicts).

**Explicitly NOT in v0:** live bank/custodian feeds, user authentication for third parties, personal recommendations (regulated advice), payments, multi-tenant hosting, native apps. v0 is local-first: it runs on the operator's machine; the only network egress is redacted calls to the Anthropic API for parsing and narrative.

**Reference competitor:** yTree (aggregation + pure advice, ~12–15bps effective capture). Meridian's differentiation: (a) cross-border US/UK intelligence nobody else automates, (b) mobile-first delivery, (c) built to sit under proper advice economics later, not to replace them.

---

## 2. Architecture principles (non-negotiable)

1. **Deterministic core, AI at the edges.** All financial computation (returns, fees, tax flags, situs, FX) is pure, deterministic, unit-tested TypeScript. LLMs are used ONLY for: (a) document → structured data extraction, (b) narrative generation from computed results, (c) fuzzy instrument matching suggestions (always human-confirmed). An LLM never computes a number that appears in a report.
2. **Local-first, privacy by construction.** All client data lives on local disk in a single project directory. The parsing pipeline redacts direct identifiers (names, addresses, account numbers → salted tokens) before any API call, and re-hydrates locally. A `NETWORK_AUDIT.md` file is auto-appended with every external call made (timestamp, endpoint, redaction confirmation).
3. **Versioned parameters.** Every tax rate, allowance, treaty rule, and regulatory threshold lives in `/params/{jurisdiction}/{tax_year}.json` with an effective-date range. No constant in engine code. (UK 2026/27 and US 2026 shipped in v0.)
4. **Golden tests everywhere.** Every engine function ships with fixture inputs and expected outputs committed to the repo. Every parser ships with at least 3 sample statements (synthetic) and their expected canonical output. `npm test` must pass green before any phase is complete.
5. **Mobile-first is a build constraint, not a polish step.** Every screen is designed at 390×844 first and desktop second. Acceptance criteria in Phase 5 include Lighthouse mobile scores.
6. **Everything is a file.** The ledger is human-readable JSON on disk. No database in v0. This makes the system auditable, diffable, and portable.

---

## 3. Repository layout

```
meridian/
├── SPEC.md                     ← this document
├── PROGRESS.md                 ← agent-maintained state: current phase, last completed step, open must-fixes
├── NETWORK_AUDIT.md            ← auto-generated egress log
├── .claude/
│   ├── settings.json           ← permissions allowlist + hooks (see §12)
│   └── agents/
│       ├── janitor.md          ← Haiku: fast tidy on changed files
│       ├── cleaner.md          ← Sonnet: periodic deeper cleanup
│       ├── structural-reviewer.md  ← Opus: phase-gate architecture & UI review
│       └── deep-technical.md   ← Fable 5: tax, maths, algorithms, complex builds
├── scripts/
│   └── run-autonomous.sh       ← long-run driver; survives usage-limit windows (§12.4)
├── params/
│   ├── uk/2026-27.json         ← UK tax year parameters
│   ├── us/2026.json            ← US tax year parameters
│   └── shared/fx-policy.json   ← FX source & fallback rules
├── schema/
│   ├── ledger.schema.json      ← canonical data model (JSON Schema, versioned)
│   └── parse-output.schema.json
├── data/                       ← gitignored; local client data only
│   └── {household-id}/
│       ├── documents/          ← raw uploaded PDFs
│       ├── ledger.json         ← the canonical ledger
│       ├── parse-runs/         ← every parse attempt, with confidence + diff
│       └── reports/            ← generated HTML reports
├── src/
│   ├── ingest/                 ← Module 1: parsing pipeline
│   ├── engine/                 ← Module 2: deterministic analytics
│   ├── usconnect/              ← Module 3: US-connected intelligence
│   ├── report/                 ← Module 4: mobile-first report generator
│   └── cli/                    ← operator CLI (meridian ingest / review / report)
├── test/
│   ├── fixtures/               ← synthetic statements + expected ledgers
│   └── golden/                 ← engine golden suites
└── package.json                ← Node 20+, TypeScript, no framework in core
```

Conventions carried over from prior tooling practice: no build step for report output (reports are self-contained single-file HTML), Node-runnable tests, versioned parameters, golden suites.

---

## 4. Canonical data model (`schema/ledger.schema.json`)

The ledger is the product. Design it once, carefully. All monetary amounts are `{ amount: number, currency: ISO4217 }`. All dates ISO 8601. All IDs are ULIDs.

```jsonc
{
  "schema_version": "0.1",
  "household": {
    "id": "ULID",
    "base_currency": "GBP",          // reporting currency, user-switchable
    "secondary_currency": "USD",     // dual-currency reporting pair
    "persons": [{
      "id": "ULID",
      "display_token": "P1",          // redaction token; real name held in local vault file
      "tax_profile": {
        "uk_resident": true,
        "uk_domicile_status": "ltr_flag",   // post-2025 UK: long-term residence flag
        "us_person": true,                   // citizen | green card | substantial presence
        "us_person_basis": "citizen",
        "state_exposure": "NY",              // optional US state
        "treaty_positions": ["uk_us_dta_pension_art17_18"]
      }
    }]
  },
  "accounts": [{
    "id": "ULID",
    "person_ids": ["..."],
    "institution": "string",
    "account_token": "A1",           // redacted account number token
    "wrapper": "gia | isa | sipp | uk_bond_onshore | uk_bond_offshore |
                us_brokerage | ira_trad | ira_roth | 401k | 529 |
                bank_current | bank_savings | property | private_holding",
    "wrapper_jurisdiction": "UK | US | OTHER",
    "custody_currency": "GBP",
    "opened": "date | null",
    "data_asof": "date"              // valuation date of last accepted parse
  }],
  "instruments": [{
    "id": "ULID",
    "identifiers": { "isin": "...", "sedol": "...", "ticker": "...", "cusip": "..." },
    "name": "string",
    "type": "equity | bond | oeic | ucits_etf | us_etf | investment_trust |
             mutual_fund_us | mmf | cash | property | private_equity | other_pooled",
    "domicile": "ISO3166",
    "hmrc_reporting_fund": true,      // from HMRC reporting fund list (bundled snapshot)
    "us_registered": false,           // '40 Act fund flag
    "pfic_status": "computed — see Module 3",
    "prices": [{ "date": "...", "price": {...}, "source": "statement | feed | manual" }]
  }],
  "holdings": [{
    "account_id": "...", "instrument_id": "...",
    "asof": "date", "units": 123.45,
    "book_cost": { "amount": ..., "currency": "..." },   // if known
    "value": { "amount": ..., "currency": "..." },
    "source_document_id": "..."
  }],
  "transactions": [{
    "account_id": "...", "date": "...",
    "type": "buy | sell | dividend | interest | fee | contribution | withdrawal | transfer_in | transfer_out | fx",
    "instrument_id": "... | null",
    "units": 0, "gross": {...}, "fees": {...}, "net": {...},
    "source_document_id": "..."
  }],
  "documents": [{
    "id": "ULID", "filename": "...", "sha256": "...",
    "institution": "...", "doc_type": "valuation | transactions | mifid_costs | contract_note | tax_voucher",
    "period": { "from": "...", "to": "..." },
    "parse_run_ids": ["..."]
  }],
  "fx_rates": [{ "date": "...", "pair": "GBPUSD", "rate": 1.28, "source": "..." }]
}
```

**Design rules:** holdings are snapshots tied to documents (auditability); transactions are optional in v0 (statement snapshots suffice for consolidated value + cost analytics; performance uses Modified Dietz between snapshots when full transactions absent — see 6.2). Nothing enters the ledger without a `source_document_id` or `source: manual` with operator initials.

---

## 5. Module 1 — Ingestion pipeline (`src/ingest/`)

**Flow:** `meridian ingest <pdf>` →
1. **Fingerprint & classify.** Hash file; heuristic + LLM classification of institution and `doc_type`.
2. **Redact.** Local regex + NER pass replaces names, addresses, full account numbers, NI/SSN patterns with stable salted tokens (`P1`, `A1`…). Mapping stored ONLY in `data/{household}/vault.local.json` (gitignored, chmod 600). Assert-redacted check runs before any network call; hard-fail if a raw account-number pattern survives.
3. **Extract.** Call Claude (claude-sonnet-4-6 via API) with the redacted document and a strict extraction prompt returning JSON conforming to `parse-output.schema.json`: institution, period, accounts, holdings (name, identifier candidates, units, price, value, currency), fees found, cash movements. Response is schema-validated (ajv); invalid → one retry with the validation errors appended; still invalid → parked in `parse-runs/failed/` for manual entry.
4. **Match instruments.** Deterministic match on ISIN/SEDOL/CUSIP first; else fuzzy name match proposes candidates (never auto-accepts). Unknown instruments create draft records flagged `needs_review`.
5. **Confidence & diff.** Every extracted figure carries a confidence score. The run produces a REVIEW file: a mobile-friendly single-file HTML diff showing current ledger vs proposed changes, per-figure confidence, and side-by-side page images for anything <0.9 confidence.
6. **Accept.** `meridian review <run-id>` opens the diff; operator accepts/edits/rejects line-by-line. Only accepted lines enter `ledger.json`. Every acceptance is logged with timestamp.

**Priority parsers (ship synthetic fixtures for each):** (1) UK platform valuation statements (generic layout), (2) private-bank consolidated valuations, (3) MiFID II ex-post cost & charges disclosures — a first-class doc_type, because it is the legally mandated fee dataset every UK manager must produce and powers the cost analytics, (4) US brokerage statements (generic), (5) SIPP/pension annual statements.

**Acceptance criteria (Phase 2):** 3 synthetic fixture statements per priority parser parse to expected canonical output byte-for-byte after operator acceptance; redaction assertion has a failing test proving it blocks an unredacted call; NETWORK_AUDIT.md records every API call.

---

## 6. Module 2 — Analytics engine (`src/engine/`)

Pure functions: `(ledger, params, options) → results`. No I/O, no dates from the system clock (asof passed in). Every function has a golden suite.

**6.1 Consolidation.** Total wealth by: person, account, wrapper, jurisdiction, asset class, currency of underlying exposure (look-through where instrument metadata allows), liquidity tier. Everything renderable in base AND secondary currency simultaneously (dual-column is the signature of the product).

**6.2 Performance.** Where full transactions exist: true time-weighted return (TWR) with daily linking, and money-weighted (XIRR). Where only periodic snapshots + flows exist: Modified Dietz per period, chain-linked, clearly labelled as estimate with the assumption stated. Benchmarks: user-assigned composite per account (e.g., 60/40 in GBP terms) from bundled index series (`params/shared/benchmarks/`, monthly, extendable). Report both nominal and real (CPI series in params).

**6.3 Cost stack.** Per account and total: ongoing product/platform %, fund OCF (from instrument metadata or MiFID doc), advice fees, transaction costs, FX spreads where visible. Output: total annual £ and bps, plus a 20-year compounding-drag projection at user growth assumption. This screen is the yTree-killer moment; make it exact and sourced (every number traceable to a document).

**6.4 Risk & exposure.** Concentration (top-10 positions, single-issuer >5% flags), currency exposure vs currency-of-life (see Module 3), equity/bond/alt split, geographic split, unwrapped-vs-wrapped ratio per jurisdiction.

**Acceptance criteria (Phase 3):** golden suites pass for: TWR vs XIRR divergence case, Modified Dietz vs known TWR tolerance case, dual-currency consolidation with a deliberately awkward FX date-mismatch fixture, cost-stack reconciliation to a synthetic MiFID disclosure to the penny.

---

## 7. Module 3 — US-connected intelligence (`src/usconnect/`) — FIRST-CLASS, BUILT IN PHASE 3 NOT LAST

This module is the moat. It runs automatically whenever any household person has `us_person: true`.

**7.1 PFIC detector.** Rule cascade per instrument held by/for a US person:
- `us_registered == true` ('40 Act) → NOT PFIC.
- Direct equities/bonds/cash → NOT PFIC.
- Non-US domiciled pooled vehicle (OEIC, UCITS ETF/fund, investment trust, offshore fund, most non-US ETFs, UK REIT treatment flagged separately) → **PFIC: flag CRITICAL**, with: holding value, account/wrapper, an explanation block (excess-distribution regime default; QEF/MTM elections exist but statements are rarely available for UK funds), and the Form 8621 filing implication per holding.
- Ambiguous types → flag `needs_classification` for operator.
- Edge cases encoded in params, not code: US-listed ETFs domiciled in US = fine; Ireland-domiciled UCITS held in a SIPP → still PFIC-relevant question but treaty pension wrapper mitigation → flag as WARN with wrapper context, not CRITICAL.
- Output: PFIC exposure table (count, total value, % of investable wealth) + per-holding detail.

**7.2 Wrapper-conflict map.** Deterministic matrix in `params/shared/wrapper-matrix.json`, rendered per household:
- ISA: UK tax-free, **US-taxable** (no treaty recognition) → WARN, with annual US drag estimate if holdings data allows.
- SIPP/UK pensions: treaty-recognised (Art. 17/18 positions) → OK badge with assumptions stated.
- Onshore/offshore UK bonds held by US persons → CRITICAL (PFIC-in-a-wrapper + potential 953(d) issues) → flag only, no advice text.
- Roth/IRA/401(k) for UK residents → UK treatment notes per treaty.
- Each cell carries `severity`, `explanation`, `sources[]` (statute/treaty article references as strings, no external links required).

**7.3 Situs & estate exposure sketch.** Per asset: UK IHT in-scope (post-2025 long-term-residence rules from params) vs US estate tax situs (US-situs assets: US stocks incl. via ADR, US real property, tangible US property; non-US-situs: non-US stocks, most cash deposits) → two-column estate-exposure table per person with the treaty credit noted as a modelling assumption. Label the whole section "exposure sketch — not advice."

**7.4 Currency-of-life.** Operator sets each person's spending currency mix (e.g., 80% GBP / 20% USD). Engine compares to portfolio currency exposure → mismatch score and the dual-currency wealth chart defaults to this framing.

**Acceptance criteria (Phase 3):** fixture household "US-citizen partner at a London law firm, GIA of UK OEICs + ISA + SIPP + US 401(k)" produces: correct PFIC list (every OEIC and UCITS ETF flagged, direct shares not), ISA WARN, SIPP OK, situs table splitting the 401(k) and US shares correctly. A UK-only fixture household produces zero US-module output (module silently absent, not empty sections).

---

## 8. Module 4 — Mobile-first client report (`src/report/`)

**Deliverable:** one self-contained HTML file per report run (inline CSS/JS, no CDN, no build step) that is: installable as a PWA when served, fully functional offline once opened, and printable to A4 acceptably. Also a `--deck` mode producing a paged summary for screen-sharing.

**Mobile-first requirements (hard):**
- Designed at 390×844 first; single-column flow; desktop gets a 2-column enhancement at ≥900px only.
- Touch targets ≥44px; all charts render legibly at 390px with horizontal-scroll explicitly forbidden.
- Performance budget: ≤400KB total file (charts drawn with hand-rolled SVG, not a chart library), first render <1s on a mid-range phone, Lighthouse mobile ≥90 performance / ≥95 accessibility.
- `prefers-reduced-motion` respected; visible keyboard focus; WCAG AA contrast.
- Numbers formatted per locale with explicit currency symbols always (never bare numbers in a dual-currency product).

**Design direction (make it distinctive, not templated):** the product's identity is *two currencies, one truth*. Signature element: the dual-currency ledger column — every headline value rendered as a stacked GBP/USD pair with a fine vertical rule between, echoing a banker's ledger; the currency toggle animates a swap of primacy rather than hiding one. Palette: deep ink navy `#101B2D` on paper-white `#FAFAF7`, with a single restrained accent in oxidised brass `#8C7A3F` for flags/highlights and a dedicated alert red reserved exclusively for PFIC/CRITICAL items so red *means* something. Type: a characterful display serif for section titles and the wealth headline (e.g., an old-style figure serif), a clean humanist sans for body, tabular-lining figures mandatory for all numbers. No gradients, no glassmorphism, no decorative numbering. Structure encodes meaning: sections are ordered by the client's questions ("What do I have? What did it cost? How did it do? What should worry me?"), and the US-connected section, when present, opens with the single count of critical flags, not prose.

**Report sections (in order):** 1) Total wealth, dual currency, asof date and data-freshness per account; 2) Cost stack with 20-year drag; 3) Performance vs benchmark, labelled by method (TWR/Dietz); 4) Exposure & concentration; 5) US-connected intelligence (conditional); 6) Data appendix — every figure's source document and parse date (this appendix IS the trust product).

**Narrative:** `meridian report --narrate` sends the computed results JSON (numbers only, no client identifiers) to the API and returns 150–250 words of plain-English summary per section, inserted as clearly attributed "commentary" blocks. Narrative never introduces a number not present in the computed results (validate: every numeral in narrative must appear in results JSON, else reject).

**Acceptance criteria (Phase 5):** fixture household renders <400KB; Lighthouse thresholds met; offline reopen works; a PFIC-free household shows no red anywhere; print preview produces sane A4.

---

## 9. Security, privacy, compliance rails

- `data/` gitignored from commit 0; pre-commit hook greps staged files for ISIN-adjacent account patterns and common name tokens from the vault; refuses commit on hit.
- Vault file (`vault.local.json`) never leaves disk; all reports render redaction tokens replaced locally at generation time.
- Anthropic API calls: redacted content only; log every call in NETWORK_AUDIT.md; support `--offline` flag that disables all egress (parsing then requires manual entry mode).
- Prominent constant banner in every report footer: "Analysis and information only. Not a personal recommendation. Not tax advice. US tax outcomes depend on elections and filings not visible to this system."
- LICENSE and NOTICE: personal project, no employer IP, clean-sheet declaration in README.
- v0 handles synthetic/own data only. Before any third-party client data: ICO registration, DPIA, retention policy, and a regulatory-perimeter review are prerequisites — tracked as `PRE_LAUNCH.md` checklist, not code.

---

## 10. Build phases for Claude Code

| Phase | Deliverable | Acceptance gate |
|---|---|---|
| 1 | Repo scaffold, schema + ajv validation, params files (UK 26/27, US 26, wrapper matrix, benchmarks), fixture synthetic statements (5 institutions × 3 docs) | `npm test` green on schema + params round-trip |
| 2 | Ingestion pipeline: redaction, extraction, matching, review diff HTML, accept flow | §5 criteria |
| 3 | Engine + US-connected module | §6 + §7 criteria |
| 4 | CLI wiring (`ingest`, `review`, `report`, `households`), NETWORK_AUDIT, pre-commit hooks | end-to-end: pdf → accepted ledger → results JSON on fixture |
| 5 | Mobile-first report + PWA + narrative mode | §8 criteria |
| 6 | Hardening: failed-parse manual entry mode, `--offline`, second fixture household (UK-only), README + PRE_LAUNCH.md | full regression green; demo script runs both households start-to-finish |

**Working style for Claude Code:** implement phase-by-phase; at each phase start, restate the acceptance criteria as failing tests first; never merge a phase with skipped tests; keep every module under 500 lines per file; prefer boring code in the engine and spend cleverness only in the report design. Agent delegation, phase-gate reviews, and long-run orchestration are defined in §12; a phase is only complete when its tests pass AND its structural review (Opus) has zero open MUST-FIX items. PROGRESS.md is updated after every step so any resumed session knows exactly where it stands.

---

## 12. Autonomous operation: model-tiered agents and long-run orchestration

This project is built largely unattended in Claude Code auto mode. Model assignment is a cost-and-quality policy: cheap models run constantly, expensive models run at gates or on demand. All agents live in `.claude/agents/` and are available to the main loop as subagents.

### 12.1 Agent roster

**`janitor.md` — Haiku, runs constantly.**
```markdown
---
name: janitor
description: Fast tidy pass on files changed by the last edit. Use proactively after code changes.
model: haiku
tools: Read, Edit, Grep, Bash(npm run lint:*), Bash(npm run format:*)
---
You tidy code without changing behaviour: dead imports, unused vars, naming
consistency with SPEC.md conventions, comment accuracy, file ordering.
HARD RULES: never modify logic, tests, /test/golden/, /params/, or schema files;
never touch more than the files named in your task; if a change might alter
behaviour, report it instead of making it.
```
Mechanical formatting is NOT an agent job: a PostToolUse hook runs `prettier --write` and `eslint --fix` on changed files at zero model cost (see 12.3). The janitor handles only what linters can't.

**`cleaner.md` — Sonnet, runs at natural pauses (end of each numbered step within a phase).**
```markdown
---
name: cleaner
description: Deeper structural cleanup at step boundaries. Use after completing a step, before committing.
model: sonnet
tools: Read, Edit, Grep, Glob, Bash(npm test:*), Bash(git diff:*)
---
You refactor for clarity within the current phase's files: extract duplicated
logic, split any file over 500 lines, align module boundaries with SPEC.md §3.
Tests must be green before AND after your work — run them; if red after your
change, revert your change. Never rewrite golden fixtures to make tests pass.
```

**`structural-reviewer.md` — Opus, runs once per phase gate.**
```markdown
---
name: structural-reviewer
description: Phase-gate review of architecture and UI. Invoke after a phase's acceptance criteria pass, before starting the next phase.
model: opus
tools: Read, Grep, Glob, Bash(npm test:*), Bash(git log:*)
---
Review the completed phase against SPEC.md: architecture conformance (§2
principles, §3 layout, deterministic-core rule), schema discipline, and — for
any report/UI work — full conformance to §8 (mobile-first budgets, design
system, dual-currency signature, accessibility). Write PHASE_REVIEW_{n}.md
with findings triaged MUST-FIX / SHOULD-FIX / NOTE. You review; you do not
edit code. Be specific: file, line, spec section violated.
```
The main loop must resolve all MUST-FIX items (delegating to the right agent) and re-run the phase's tests before opening the next phase. This is enforced in the phase table: no phase begins while the previous PHASE_REVIEW contains an open MUST-FIX.

**`deep-technical.md` — Fable 5, on-demand for the hard problems.**
```markdown
---
name: deep-technical
description: Expert for tax logic, financial mathematics, algorithms, and complex builds. Use for Module 2 engine functions, all of Module 3 (PFIC, situs, wrapper matrix), parsing edge cases, and any bug the main loop fails to fix in two attempts.
model: claude-fable-5
tools: Read, Edit, Write, Grep, Glob, Bash(npm test:*)
---
You own correctness in: return mathematics (TWR daily-linking, Modified Dietz,
XIRR), FX handling, cost-stack reconciliation, PFIC rule cascade, situs and
wrapper-conflict logic, and algorithmic design. Method: write or extend the
failing golden test FIRST, then implement; every rate/threshold comes from
/params/ (never a literal in code); every tax rule you encode gets a source
string in the params entry. If a rule is genuinely ambiguous, encode the
conservative reading and log the ambiguity in PROGRESS.md for human review.
```
Availability note: confirm the exact model string available on your plan (`/model` in Claude Code, or `claude --model claude-fable-5 -p "ping"`). If Fable 5 is not exposed on your plan, set `model: opus` in this agent and keep the same brief.

### 12.2 Cost policy (why this tiering)

Haiku on every edit is near-free; Sonnet at step boundaries is the workhorse; Opus roughly six times per project (one per phase gate); Fable 5 only where an error is expensive (a wrong Dietz implementation or PFIC misclassification poisons everything downstream — this is exactly where the premium model pays for itself). The main loop itself should run on Sonnet by default; it escalates by delegation, not by switching its own model.

### 12.3 Hooks (`.claude/settings.json`)

```jsonc
{
  "permissions": {
    "allow": [
      "Bash(npm test:*)", "Bash(npm run lint:*)", "Bash(npm run format:*)",
      "Bash(git add:*)", "Bash(git commit:*)", "Bash(git diff:*)", "Bash(git log:*)",
      "Bash(node:*)", "Edit", "Write", "Read", "Grep", "Glob"
    ],
    "deny": [
      "Bash(git push:*)", "Bash(rm -rf:*)", "Bash(curl:*)", "Bash(wget:*)",
      "Read(./data/**/vault.local.json)", "Edit(./test/golden/**)", "WebFetch"
    ]
  },
  "hooks": {
    "PostToolUse": [{
      "matcher": "Edit|Write",
      "hooks": [{ "type": "command",
        "command": "npx prettier --write \"$CLAUDE_FILE_PATHS\" 2>/dev/null; npx eslint --fix \"$CLAUDE_FILE_PATHS\" 2>/dev/null || true" }]
    }],
    "Stop": [{
      "hooks": [{ "type": "command",
        "command": "npm test --silent >> run.log 2>&1 || echo 'TESTS RED AT STOP' >> PROGRESS.md" }]
    }]
  }
}
```
Rationale: formatting is free and instant via hooks; the deny list makes auto mode safe (no push, no network, no destructive deletes, golden fixtures immutable, vault unreadable); a Stop hook snapshots test status into PROGRESS.md so every session ends with an honest state record.

### 12.4 Long-run driver: surviving usage-limit windows

Claude Code has no native "wait for reset and continue" — the reliable pattern is a wrapper that resumes the same session after the window resets. Requirements: PROGRESS.md is the cross-session memory (the main loop must update it after every completed step — this is written into CLAUDE.md), and `claude --continue` resumes the prior conversation.

`scripts/run-autonomous.sh`:
```bash
#!/usr/bin/env bash
# Meridian long-run driver. Usage: nohup ./scripts/run-autonomous.sh &
set -u
cd "$(dirname "$0")/.."
PROMPT='Read SPEC.md and PROGRESS.md. Continue from the recorded state.
Follow §10 phase gates and §12 agent policy exactly. Update PROGRESS.md
after every completed step. When Phase 6 acceptance passes and the final
structural review has zero MUST-FIX items, create DONE.md and stop.'

while [ ! -f DONE.md ]; do
  claude --continue --permission-mode acceptEdits -p "$PROMPT" \
    >> run.log 2>&1
  EXIT=$?
  if [ -f DONE.md ]; then break; fi
  if tail -n 40 run.log | grep -qiE "usage limit|rate.?limit|resets at"; then
    echo "$(date -Is) limit hit — sleeping 5h10m" >> run.log
    sleep 18600            # 5h + 10min buffer past the window reset
  else
    echo "$(date -Is) exited (code $EXIT) — brief backoff, resuming" >> run.log
    sleep 120              # crash/complete-turn backoff; harmless if work remains
  fi
done
echo "$(date -Is) DONE.md present — build complete" >> run.log
```
Run it under `nohup`/`tmux` so it outlives your terminal. Notes: (a) the sleep is a pragmatic buffer — if your plan's reset banner includes a timestamp, you can parse it, but the fixed 5h10m sleep is simpler and robust; (b) if you ever run on API billing instead of a subscription, there are no 5-hour windows and the limit branch simply never triggers; (c) check `run.log` and `git log` each morning — autonomous means unattended, not unaudited.

### 12.5 Safety rails for unattended auto mode

Git commit at every step boundary with the step name (enforced in CLAUDE.md), so any overnight drift is one `git revert` away; tests-as-gates mean a red suite blocks phase progression rather than compounding; the deny-list keeps the blast radius inside the repo; and the reviewer's MUST-FIX mechanism is the structural backstop against the main loop marking its own homework. The one thing the human still owns: read each PHASE_REVIEW before trusting the phase.

---

## 13. Post-v0 roadmap (out of scope, recorded for orientation)

v1: local web app with auth for a second operator; persistence moves to SQLite; live FX + EOD price feed; HMRC reporting-fund list auto-refresh. v2: rented aggregation (bank feeds via TPP; wealth aggregator for custodians); client-facing portal; multi-household. v3: adviser workflow (this is where regulated advice economics attach). Each step is additive on the same ledger schema — which is why Phase 1 matters most.
