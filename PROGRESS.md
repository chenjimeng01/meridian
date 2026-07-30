# PROGRESS

**Current phase:** 6 complete — v0 feature-complete; web UI in progress
**Status:** 178/178 green, lint + typecheck clean; demo script runs both
households start-to-finish — awaiting phase-gate review
**Last completed step:** 6.2 global --offline

## Phase 6 step plan

Gate (§10): full regression green; demo script runs both households
start-to-finish.

- [x] 6.1 Manual entry (`meridian manual`): a parked document gets a redacted
      template pre-filled only with what can be read without guessing, and a
      filled-in entry rejoins the ORDINARY review and accept flow — a different
      way to produce the extraction, not a way to bypass acceptance. The figure
      stays traceable to the original document's bytes.
- [x] 6.2 `--offline` is now a property of the run rather than of one
      subcommand, and `report --narrate` refuses under it instead of silently
      skipping. A test drives a full report offline, reaching it through manual
      entry alone — §9's "parsing then requires manual entry mode" is now true
      rather than a dead end.
- [x] 6.3 Second (UK-only) fixture household — built by `scripts/demo.sh`,
      verified to contain no US section and no alert red at all.
- [x] 6.4 README covers the demo, the real-document workflow and manual entry;
      PRE_LAUNCH.md has been in place since Phase 1.
- [x] 6.5 Demo script runs both households start-to-finish (the §10 gate).
- [x] 6.6 Phase gate review → PHASE_REVIEW_6.md (main loop, at the operator's
      instruction — the ONE gate not independently reviewed; see the caveat at
      the top of that file). Found and fixed: run ids reached the filesystem
      unvalidated, so `../` in an id could escape the household directory.
      4 SHOULD-FIX recorded.

**v0 is feature-complete against SPEC §10.**

## Phase 5 step plan

Acceptance (§8): fixture household renders <400KB; Lighthouse thresholds met;
offline reopen works; a PFIC-free household shows no red anywhere; print
preview produces sane A4.

- [x] 5.1 §8 acceptance criteria written as failing tests first
- [x] 5.2 Design system (`src/report/styles.ts`): ink navy on paper white, one
      brass accent, alert red EMITTED ONLY when a critical flag exists — a
      palette token sitting unused would violate the "no red anywhere" criterion
- [x] 5.3 Hand-rolled SVG charts, no chart library
- [x] 5.4 Report renderer: sections ordered by the client's questions, the
      dual-currency pair as the signature element, a currency toggle that swaps
      primacy rather than hiding a currency
- [x] 5.5 PWA (inline data-URL manifest + blob service worker, failing silently
      on file://), A4 print stylesheet, `--deck` paged mode
- [x] 5.6 Narrative mode: every numeral in generated commentary must appear in
      the computed results or the section is dropped, not rendered
- [x] 5.7 Phase gate: PHASE_REVIEW_5.md (Opus) — 7 MUST-FIX, 14 SHOULD-FIX,
      13 NOTE
- [x] 5.8 MUST-FIX resolution (168/168 green):
      - M1 the drag chart re-derived the projection with a hard-coded 5%, so at
        any other growth assumption the chart contradicted the sentence beneath
        it. `compoundingDrag` now returns the rates it used.
      - M2 `table { min-width: 30rem }` put the severity and value columns of a
        PFIC row off-screen at 390px — the exact device §8 designs for. Tables
        now fit the viewport; genuinely secondary columns drop below 34rem and
        return on wider screens and in print.
      - M3 the button labelled "Show in USD" changed exactly one number. Every
        figure is now a pair (45 of them, verified in-browser), `.rowpair`
        responds to the toggle, and the engine exposes the single rate behind
        the report so both columns reconcile.
      - M4 the service worker never registered — Chrome rejects `blob:` worker
        scripts, so a single-file report cannot have one. Rather than ship
        plumbing that always threw, it is removed; the manifest gained icons
        and a resolvable `start_url`. See the limitation note below.
      - M5 `narrateSection` posted the operator's own filenames and wrote
        `redaction_check: "pass"` without ever checking. It now strips
        filenames, asserts the payload clean (tokens only, no paths), and only
        then writes the audit row.
      - M6 brass `#8C7A3F` on paper is 4.04:1 — below AA — and coloured every
        eyebrow, chip and byline. Text now uses `#6B5C2E` (5.6:1); the original
        accent is confined to bars and rules, which need 3:1. A test computes
        the ratios rather than trusting the palette.
      - M7 `--deck` was the report with a class; slides ran to 3.8x the
        viewport. It is now a genuine paged summary — one idea per slide,
        capped to `100svh`, 16KB against the report's 40KB, and it keeps the
        currency toggle.
      - Narrative validator: the year exemption accepted any amount from 1900
        to 2099 (`£1,950` passed). Whole ISO dates present in the results are
        now excluded first and bare four-digit runs must appear in the results;
        scale words and spelled-out magnitudes are refused; and advice-like
        phrasing is refused by code rather than only by prompt instruction.
        All five adversarial probes now fail closed.

## Known limitations recorded rather than hidden

- **Lighthouse still not run.** Neither binary is installed and the permission
  deny-list blocks installing one, so §8's ">=90 performance / >=95
  accessibility" remains UNVERIFIED and is a human step. Contrast is now
  computed in the test suite, which closes one thing Lighthouse would catch.
- **True PWA installability is at odds with a single self-contained file.**
  A service worker must be separately fetchable; `blob:` and `data:` scripts
  are rejected. The report ships a complete manifest and is genuinely offline
  once opened (it has no network dependencies at all), but a browser install
  prompt needs a host page that serves a worker. Recorded as a deliberate
  trade-off, not an omission.

## SHOULD-FIX debt — cleared

- [x] **S8 disposal semantics.** `latestHoldings` took the latest snapshot per
      (account, instrument), so a position sold and absent from the newest
      statement was resurrected forever — it stayed in the client's total, in
      their concentration flags and in their PFIC list. Each account is now
      read at its own most recent valuation date, which is what a statement
      actually asserts. Regression test sells a holding and checks it leaves.
      This also corrected the FX fixture, which had modelled two valuation
      dates inside one account — an impossible statement.
- [x] **S10 concentration base.** Measured against total wealth, a 6% position
      reads as 4% simply because a deposit account sits beside it. Now measured
      against investable wealth, with the exclusions in params and reported on
      the result so the denominator is visible.
- [x] **S2/S3 rounding.** `Math.round` replaced with the half-even the fx
      policy mandates, everywhere it reached a presented figure.
- [x] **S4 FX pivot and ignored policy.** The USD pivot is now read from
      params, and `policyOf` FAILS if the policy asks for a date or cross-rate
      rule the engine does not implement — a params file the engine silently
      ignores documents a behaviour nobody has.
- [x] **S9 the two currency columns.** They are the same wealth measured two
      ways — base struck at each holding's own valuation date, secondary
      converted at one report-date rate — and the report now says so, with the
      rate and its date.
- [x] **Table semantics.** Every header cell carries `scope="col"`.
- [x] **Params naming wart.** `situs-rules.json` and `currency-of-life.json`
      split out of `pfic-rules.json`, where they lived only because the Module
      3 agent was scoped to one writable file.

Still open (lower value, none affecting a reported figure): S1 unrounded floats
inside the `usconnect` result object; S6 the cost-stack golden reconciles
against hand-typed constants rather than ingested figures; S7 three engine
entry points take loose arguments rather than a ledger; plus the remainder of
PHASE_REVIEW_5's SHOULD-FIX list (non-text contrast below 3:1 on some chart
fills, chart `<caption>` elements).

## Phase 5 findings

- **Lighthouse was NOT run.** Neither `lighthouse` nor `lhci` is installed on
  this machine, so the "Lighthouse mobile >=90 performance / >=95
  accessibility" criterion is UNVERIFIED. What was verified instead: the report
  is 36KB against a 400KB budget, makes zero network requests, has no
  horizontal scroll, and carries the accessibility rails §8 lists
  (reduced-motion, visible focus, landmarks, 44px targets, text alternatives on
  every chart). Someone must run Lighthouse before this criterion can be
  claimed.
- **SVG text does not belong in a scaled chart.** Labels sized correctly at
  390px rendered at roughly 30px on desktop, because `<svg width="100%">`
  scales its own text with the container. Chart text is now HTML — real,
  selectable, respecting the reader's font size — and the SVG carries geometry
  only. Bars are `aria-hidden` because the adjacent text already says what they
  say; charts that carry information text cannot (the drag projection, the cost
  band) keep `role="img"` and a `<title>`.
- **Cash was being reported as "needs classification".** The §7.1 gate is right
  to distrust inferred metadata, but cash is not inferred — the pipeline
  creates it from an explicit cash-balance line. It is now created
  `metadata_confirmed: true`, which removed six meaningless rows from the PFIC
  table. The end-to-end test was narrowed to match the real guarantee
  (instruments read off a document) rather than weakened.
- **Wrapper enums were leaking into the client report** ("bank_savings",
  "us_brokerage"). Presentation labels now live in `src/report/format.ts`.

## Phase 4 step plan

Acceptance gate (§10): end-to-end — document → accepted ledger → results JSON
on the fixture household.

- [x] 4.0 Entry task S13 (see below) — metadata confirmation is an operator
      decision, so a real ingested ledger can produce PFIC flags at all
- [x] 4.1 Acceptance criteria written as failing tests first (`test/cli.test.ts`)
- [x] 4.2 Local-first store (`src/cli/store.ts`): the §3 directory layout,
      content-addressed documents, owner-only vault, parse-runs incl. failed/,
      reports/ — closes PHASE_REVIEW_2 S8 (parked runs and review files are
      now actually written to disk)
- [x] 4.3 `meridian households create|list`
- [x] 4.4 `meridian ingest <file>`: PDF→text at the boundary via pdftotext with
      a clear message when it is absent; redact, extract, match, write the
      review file; a document that cannot be parsed parks in parse-runs/failed/
- [x] 4.5 `meridian review <run-id>`: --accept-all or --decisions <file> for
      per-line accept/edit/reject, plus --confirm-metadata to unlock the §7.1
      cascade; refuses to guess if given neither
- [x] 4.6 `meridian report`: runs the whole engine + Module 3 into a results
      JSON with the §8 data appendix (source document AND parse date per figure)
- [x] 4.7 Phase gate: PHASE_REVIEW_4.md (Opus reviewer) — 7 MUST-FIX,
      20 SHOULD-FIX, 16 NOTE
- [x] 4.8 MUST-FIX resolution (148/148 green):
      - M1 PDF path: the fingerprint is now of the FILE, not of its text
        rendering (two PDFs can render identically; a poppler upgrade would
        otherwise change a document's identity), and `documents/` keeps the
        original bytes rather than text under a .pdf name. The converter is
        injectable, so the branch is now genuinely exercised, and a missing
        converter is reported differently from a corrupt or encrypted PDF.
      - M2 id collisions: `collectIds` now includes `documents[].parse_run_ids`,
        every mint site seeds from `listAllRunIds()` (which descends into
        failed/), and the CLI clock keeps millisecond precision. Two
        unparseable documents ingested in the same second previously
        overwrote each other in parse-runs/failed/ — silent loss on the one
        path §5.3 exists to prevent.
      - M3 `review` is idempotent: re-accepting a run is refused by default
        (it silently duplicated documents, holdings and fee transactions,
        moving the cost headline by the full duplicated amount), with
        `--reaccept` reversing the prior acceptance first.
      - M4 the cost stack is windowed to a stated year and its bps denominator
        is the whole portfolio — the same base the 20-year drag is applied to.
        The headline fell from £4,133/226.92bps (four years presented as one)
        to £1,418/33.62bps, and the drag from £415,690 to £72,952.
      - M5 fee `label` and `category` now survive the ledger round-trip, so
        the breakdown is the document's own (platform 1,080 / fund OCF 198 /
        transaction 88 / FX 52) rather than 100% "platform".
      - M6 §6.2 performance is in the results JSON via a new ledger→
        Valuation[]/Flow[] adapter, with the method label and an optional
        benchmark comparison. This also closes PHASE_REVIEW_3 S7.
      - M7 §9: `household.json` no longer duplicates the vault's names and
        addresses and is mode 600; a parked raw document is mode 600; the
        vault is persisted before the park path re-throws.

## Phase 3 step plan

Acceptance criteria — §6: golden suites for (a) TWR vs XIRR divergence,
(b) Modified Dietz vs known TWR tolerance, (c) dual-currency consolidation with
an awkward FX date-mismatch, (d) cost-stack reconciliation to a synthetic MiFID
disclosure to the penny. §7: the acceptance household produces the correct PFIC
list, ISA WARN / SIPP OK, and a correct situs split; a UK-only household
produces no US-module output at all.

- [x] 3.0 Foundations: `metadata_confirmed` on instruments (PHASE_REVIEW_2 S7),
      `params/shared/pfic-rules.json`, `params/shared/asset-classes.json`,
      and the two Phase 3 test households (§7 acceptance + UK-only), both
      schema-valid and deterministically generated
- [x] 3.1 §6 acceptance criteria written as tests first
- [x] 3.2 FX (`src/engine/fx.ts`): fx-policy source order, never a rate later
      than the valuation date, staleness warning, refusal beyond the limit,
      USD triangulation, half-even rounding — 11 tests
- [x] 3.3 Performance (`performance.ts`): TWR daily-linked, XIRR
      (Newton + bisection), Modified Dietz always labelled an estimate with its
      assumption stated, chain-linking, real returns — 9 tests, both §6.2
      acceptance cases verified against closed-form answers
- [x] 3.4 Cost stack (`cost.ts`): reconciles to the MiFID fixture to the penny
      (£1,158.00 / 141.22 bps), refuses any unattributed line, 20-year
      compounding drag — 6 tests
- [x] 3.5 Consolidation + risk (`consolidate.ts`, `risk.ts`): eight slices that
      all sum back to the total, dual currency, concentration flags, wrapped vs
      unwrapped per jurisdiction, geographic split — 10 tests
- [x] 3.6 Module 3 — US-connected intelligence (deep-technical agent, 17 tests).
      §7 acceptance verified independently by the main loop, not just by the
      agent's own tests: both UK OEICs and the UCITS ETF flag PFIC CRITICAL;
      the same ETF inside the SIPP flags WARN (wrapper-mitigated); direct
      shares and both US-registered funds are not_pfic; the unconfirmed
      Harbour Point fund routes to needs_classification (S7 honoured);
      ISA WARN / SIPP OK; situs puts the 401(k) *and* the US-incorporated
      share held in a UK GIA on the US side; UK-only household returns null.
- [x] 3.7 Phase gate: PHASE_REVIEW_3.md (Opus reviewer) — 4 MUST-FIX,
      13 SHOULD-FIX, 14 NOTE
- [x] 3.8 MUST-FIX resolution (125/125 green):
      - M1 the §6 FX date-mismatch criterion is now exercised through
        consolidation, not only at the `convert()` unit: new
        `household-fx-mismatch.json` where no rate lands on any valuation date,
        one leg is stale enough to warn, EUR triangulates via USD, and two
        holdings are valued on different dates. Plus tests for refusal when a
        holding cannot be valued in base, and graceful degradation when the
        secondary rate is missing — both previously dead code paths.
      - M2 the dual-currency column reconciles: secondary figures now derive
        from the UNROUNDED base and are rounded once, with the rounding
        residual allocated to the largest slice, so every column adds up to
        its own headline exactly. The sum-to-total test now asserts BOTH
        currencies to the penny instead of only `.base` with a 0.05 tolerance.
        NOTE: the correct full-precision USD headline is 317,854.69 (was
        317,854.68 when double-rounded) and 566,476.21 on the golden ledger.
      - M3 `timeWeightedReturn` declared a `flowAtEnd` it never read, so using
        the documented API as documented returned +400% instead of 0%. The API
        now takes observations whose opening value is DERIVED from the previous
        value plus its flow, making the mistake unrepresentable, and
        `trueTimeWeightedReturn` implements §6.2's daily linking — refusing
        rather than approximating when a flow date has no valuation.
      - M4 §6.2 benchmarks and real returns built (`src/engine/benchmark.ts`):
        weighted composites from the bundled monthly series, index levels read
        on-or-before the date (mirroring the FX rule), nominal AND real via the
        CPI series, and the portfolio's method label travelling with the
        comparison so an estimate is never presented as exact.
- [x] 3.9 Carried-forward SHOULD-FIX cleared: S4 low-confidence review branch
      now exercised; S5 cash balances and statement FX observations carry
      confidence scores (`scoredMoney`), stripped at the ledger boundary;
      S9 the `Ledger` type mirrors §4 instead of seven `any[]` collections —
      which immediately caught a `"non_ltr"`/`"not_ltr"` typo in a test.

## Phase 4 findings

- **A fabricated +180% return.** Building the portfolio valuation series by
  summing whatever snapshots shared a date meant accounts arriving mid-period
  read as growth: the fixture reported +180% where the truth is +1.27% over the
  window in which every account is actually represented. Portfolio values are
  now carried forward per account and the series starts only once every account
  has a valuation, with the truncation stated. Found by reading the CLI output,
  not by any test.

- **Run-id collision (found by the end-to-end test).** Parse runs live on disk
  before anything they contain reaches the ledger, so with a fixed clock and an
  unaccepted ledger every ingest generated the SAME run id and silently
  overwrote the previous run's directory. `ledgerIds` now seeds from runs on
  disk as well as from the ledger.
- **Module 3 double-counted historic snapshots (found by running the CLI for
  real).** `buildPositions` read every holding row instead of the latest
  snapshot per (account, instrument), so a household with three statements per
  account reported investable wealth of £1,265,902 against an actual £442,559
  and tripled the critical-flag count. It also converted every snapshot at the
  report date rather than its own valuation date. Both fixed; Module 3 now
  shares `latestHoldings` with the consolidation so the two cannot drift, and a
  regression test asserts the two totals reconcile on a multi-snapshot ledger.
  The single-date acceptance fixture could never have caught this — which is
  the argument for running the real pipeline, not just the unit fixtures.

## Remaining PHASE_REVIEW_3 SHOULD-FIX

Cleared already: S5 (both new ledgers now inside the schema gate), S11 (the
params sourcing rule now walks EVERY params file, not a hand-listed subset),
S12 (the PHASE_REVIEW_2 carry-overs).

- [x] **S13 FIXED.** Metadata confirmation is now a first-class operator
      decision (`LineDecision.confirmMetadata` → `applyMetadataConfirmation`),
      written to the acceptance log and surfaced in the review file as a
      "confirm type & domicile" chip. `test/ingest-to-usconnect.test.ts` drives
      the genuine ingest path end to end and proves both halves: unconfirmed,
      every holding is `needs_classification` and nothing is declared safe;
      confirmed, the real ledger flags the UK OEIC and the UCITS ETF as PFIC,
      clears the direct securities, and clears the two '40 Act funds ONLY
      because the operator confirmed their registration — withhold that one
      field and Pioneer falls back to `needs_classification`.
- [ ] S1/S2/S3 float hygiene: unrounded values leak into the `usconnect`
      result object; `Math.round` is used where the fx-policy mandates
      half-even; `convert()` rounds inside the engine, contradicting the policy
      it implements. (Partly addressed — `convert()` now also returns `exact`,
      and consolidation uses it — but the rounding call sites need a sweep.)
- [ ] S4 `fx.ts` hardcodes the USD pivot and ignores two policy values it reads
- [ ] S6 the cost-stack reconciliation runs against hand-typed constants rather
      than figures that came through the ingest pipeline
- [ ] S7 only two of the five engine entry points take a ledger
- [ ] S8 `latestHoldings` has no disposal semantics and no staleness signal —
      a sold holding never disappears from the consolidation
- [ ] S9 the two currency columns are two different measurements and this is
      not stated to the reader
- [ ] S10 §6.4 concentration is per-instrument and measured against total
      rather than investable wealth
- [ ] Split `params/shared/pfic-rules.json` into properly-named files (the
      situs and currency-of-life config live there only because of a scoping
      constraint on the Module 3 agent)

## Phase 2 step plan

Acceptance criteria (§5): (a) 3 fixtures per priority parser parse to expected
canonical output byte-for-byte after operator acceptance; (b) a failing-path
test proves the redaction assertion blocks an unredacted network call;
(c) NETWORK_AUDIT.md records every API call.

- [x] 2.0 Entry tasks from PHASE_REVIEW_1: regen-and-byte-compare determinism
      test; §9 pre-commit PII scan hook (installed + verified blocking);
      text-ingest decision: v0 ingests .txt natively, .pdf converts at the
      Phase 4 CLI boundary (pdftotext when available, else manual conversion)
- [x] 2.1 Failing tests written restating §5 acceptance criteria (3 suites red)
- [x] 2.2 Redaction engine + vault (stable tokens, honorific stripping,
      NI/SSN/postcode/account patterns, assertRedacted hard gate, mode-600 save)
- [x] 2.3 Fingerprint & classify (sha256 of raw bytes; institution/doc_type
      registry in the fixture extractor; LLM classifies real-world docs)
- [x] 2.4 Deterministic fixture extractor — all 15 statements parse to expected
      canonical output byte-for-byte (§5 criterion a)
- [x] 2.5 LLM extractor: redaction-gated (criterion b test proves fetch is
      never reached unredacted), audit row per call (criterion c), ajv + one
      retry with errors appended, then ParkedError; offline mode refuses egress
- [x] 2.6 Matching: ISIN/SEDOL/CUSIP exact; fuzzy Jaccard proposes candidates
      only; unknown → draft needs_review
- [x] 2.7 Accept flow + golden: full 15-doc pipeline reproduces
      test/golden/ingested-ledger.json byte-for-byte; semantically equivalent
      to the Phase 1 fixture ledger (per-account totals, asof, fx)
- [x] 2.8 Mobile review diff HTML (390-first, redacted-only, confidence chips,
      prior-vs-proposed diff, <200KB)
- [x] 2.9 Phase gate: PHASE_REVIEW_2.md (Opus reviewer) — 3 MUST-FIX, 10 SHOULD-FIX, 9 NOTE
- [x] 2.10 MUST-FIX resolution (54/54 green):
      - M1 accept flow now takes per-line accept/edit/reject decisions; only
        accepted lines enter the ledger; every decision written to the new
        `acceptances[]` log with an injected timestamp; documents carry
        `parsed_at`/`accepted_at` for the §8 appendix
      - M2 `acceptRun` consumes the operator's match decision — a confirmed
        fuzzy candidate merges into that instrument instead of duplicating it,
        and the confirmation is recorded in the acceptance log
      - M3 deterministic unknown-proper-noun detector added to `assertRedacted`
        (capitalised runs with no vocabulary token), vocabulary in
        `params/shared/redaction-vocabulary.json`; verified zero false
        positives across all 15 redacted fixtures
      - Pulled forward: S1 tracked `.githooks/` + `prepare` script, S2 account
        pattern with `test/fixtures/**` allowlist, S3 vault chmod + tests,
        S6 `needs_review` narrowed to unresolvable instruments, S10 test glob,
        and `gen:golden` now requires `--force`

## Phase 3 entry tasks (remaining PHASE_REVIEW_2 SHOULD-FIX)

- [ ] S4 exercise the <0.9 confidence review branch with a synthetic run
- [ ] S5 confidence on cash balances and statement FX observations
- [ ] S7 **blocking for §7.1**: do not treat ingest-inferred `type`/`domicile`
      as authoritative in the PFIC cascade — gate on operator-confirmed
      metadata and route unconfirmed instruments to `needs_classification`
- [ ] S9 replace `any[]` in the `Ledger` type with §4-mirroring types
- [ ] Deferred to Phase 4 (CLI boundary): S8 write parked runs to
      `parse-runs/failed/` and review HTML to `data/{household}/parse-runs/`

## Phase 1 step plan

- [x] 1.1 Repo scaffold: layout per SPEC §3, package.json, tsconfig, .gitignore, README/LICENSE/NOTICE, CLAUDE.md, PRE_LAUNCH.md
- [x] 1.2 `.claude/` settings + agent roster (janitor, cleaner, structural-reviewer, deep-technical); scripts/run-autonomous.sh
- [x] 1.3 `schema/ledger.schema.json` + `schema/parse-output.schema.json` (JSON Schema 2020-12, ajv strict)
- [x] 1.4 Params: uk/2026-27.json, us/2026.json, shared/fx-policy.json, shared/wrapper-matrix.json, shared/benchmarks/ (6 synthetic series)
- [x] 1.5 Fixtures: 5 institutions × 3 synthetic statements + expected parse outputs + fixture household ledger (generated deterministically by scripts/gen-fixtures.mjs)
- [x] 1.6 Tests green: schema positive+negative, params round-trip + sourcing, wrapper-matrix/enum parity, fixture integrity (sha256, referential, pairing) — 28 pass
- [x] 1.7 Phase-gate review → PHASE_REVIEW_1.md (0 MUST-FIX)

## Phase 2 entry tasks (from PHASE_REVIEW_1 SHOULD-FIX)

- [ ] True regenerate-and-byte-compare determinism test for all fixture outputs
- [ ] Install §9 pre-commit PII grep hook (staged-file scan, refuse on hit)
- [ ] Render fixture statements to PDF or formally admit a text ingest path

## Open must-fixes

(none)

## Notes / ambiguities logged for human review

- **Redaction detector limitation (v0):** the unknown-proper-noun gate flags
  runs of two or more capitalised tokens. A bare single-token surname on its
  own line ("Ashdown") is NOT detected unless preceded by an honorific —
  single capitalised tokens are pervasive in statement layouts, so flagging
  them would make the gate unusable. Pinned by a test so it cannot be assumed
  away. Revisit if a real statement layout puts surnames on their own line.
- **Module 3 ambiguities, encoded conservatively** (logged at the
  deep-technical agent's request, for human review):
  - *US retirement plan situs.* A 401(k)/IRA interest is treated as a single
    US-situs asset with no look-through to its underlying holdings. The
    contrary look-through reading exists; the higher-exposure one is encoded.
  - *US-obligor debt.* `us_situs_debt_non_portfolio` is applied to US-domiciled
    bonds even though the portfolio-interest exclusion may remove them —
    qualification is not establishable from a statement. Unexercised by either
    fixture (no bonds), so this path has no test coverage.
  - *UK IHT scope* is read off the stored `uk_domicile_status`, not recomputed:
    the ledger holds no residence history, so the 10-of-20 test cannot be
    evaluated. Post-departure tail provisions remain unmodelled.
  - *De-minimis PFIC reporting exception* is reported as "available but
    unverified" below the threshold, because "no excess distributions and no
    elections" is invisible to this system.
  - *Currency exposure has no look-through*, so the currency-of-life mismatch
    score understates true exposure. Surfaced on the result, not just in docs.
- **Params file naming wart:** the §7.3 situs cascade and §7.4 currency-of-life
  config live in `params/shared/pfic-rules.json` purely because the Module 3
  agent was scoped to one writable params file. Split into
  `situs-rules.json` / `usconnect-rules.json`; only `readSharedRules()` in
  `src/usconnect/params.ts` changes.
- **Model tiering changed:** Fable 5 usage was exhausted mid-build, so
  `.claude/agents/deep-technical.md` now specifies `model: opus`, exactly as
  SPEC §12.1's availability note directs. PHASE_REVIEW_1 was written by the
  main loop rather than the Opus reviewer (spend limit at the time) and is
  therefore weaker evidence than PHASE_REVIEW_2, which the Opus reviewer wrote
  properly — a re-run of the Phase 1 review is still worth doing.

- US 2026 params: several 2026 inflation adjustments not yet published at build
  time; entries marked `"status": "projected"` with basis stated. Refresh when
  IRS Rev. Proc. figures land.
- Fixture statements are plain-text renderings of synthetic statements (.txt).
  Phase 2 ingestion consumes PDFs; fixtures will be rendered to PDF (or the
  pipeline given a text ingest path for fixtures) when the parser is built.
- ajv `strictRequired` disabled in tests (only that sub-flag): the ledger
  schema's source-or-manual `anyOf` requires properties defined on the parent
  subschema, which strictRequired cannot see. All other strict checks on.
- UK long-term-residence IHT tail provisions (3–10 years post-departure) not
  modelled in v0 params; flagged in params/uk/2026-27.json notes.
