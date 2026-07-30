# PROGRESS

**Current phase:** 3 complete — Phase 4 (CLI wiring) may open
**Status:** `npm test` green (125/125), lint + typecheck clean;
PHASE_REVIEW_3 MUST-FIX items all resolved, 0 open
**Last completed step:** 3.9 carried-forward SHOULD-FIX cleared

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
