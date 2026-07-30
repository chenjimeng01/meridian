# PROGRESS

**Current phase:** 1 — Repo scaffold, schemas, params, fixtures
**Status:** acceptance criteria met (`npm test` green: 28/28) — awaiting phase-gate structural review
**Last completed step:** 1.6 tests green

## Phase 1 step plan

- [x] 1.1 Repo scaffold: layout per SPEC §3, package.json, tsconfig, .gitignore, README/LICENSE/NOTICE, CLAUDE.md, PRE_LAUNCH.md
- [x] 1.2 `.claude/` settings + agent roster (janitor, cleaner, structural-reviewer, deep-technical); scripts/run-autonomous.sh
- [x] 1.3 `schema/ledger.schema.json` + `schema/parse-output.schema.json` (JSON Schema 2020-12, ajv strict)
- [x] 1.4 Params: uk/2026-27.json, us/2026.json, shared/fx-policy.json, shared/wrapper-matrix.json, shared/benchmarks/ (6 synthetic series)
- [x] 1.5 Fixtures: 5 institutions × 3 synthetic statements + expected parse outputs + fixture household ledger (generated deterministically by scripts/gen-fixtures.mjs)
- [x] 1.6 Tests green: schema positive+negative, params round-trip + sourcing, wrapper-matrix/enum parity, fixture integrity (sha256, referential, pairing) — 28 pass
- [ ] 1.7 Phase-gate: structural review (Opus) → PHASE_REVIEW_1.md, resolve MUST-FIX items

## Open must-fixes

(none — review not yet run)

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
