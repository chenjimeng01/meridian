# PROGRESS

**Current phase:** 2 complete — Phase 3 (engine + US-connected) may open
**Status:** `npm test` green (54/54), lint + typecheck clean; PHASE_REVIEW_2
MUST-FIX items all resolved
**Last completed step:** 2.10 MUST-FIX resolution

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
