# PROGRESS

**Current phase:** 1 complete — Phase 2 (ingestion pipeline) may open
**Status:** `npm test` green (28/28); PHASE_REVIEW_1.md: 0 MUST-FIX, 3 SHOULD-FIX carried into Phase 2 entry tasks
**Last completed step:** 1.7 phase-gate review written (see PHASE_REVIEW_1.md — conducted by Fable 5 main loop, Opus subagent blocked by monthly spend limit; human may wish to re-run)

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
