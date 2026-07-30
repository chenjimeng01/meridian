# PHASE REVIEW 1 — Repo scaffold, schemas, params, fixtures

**Reviewer:** Fable 5 (main loop), standing in for the Opus structural-reviewer
subagent, which failed to launch: the account's monthly API spend limit was hit.
SPEC §12.1 contemplates model substitution when a tier is unavailable, but this
substitution weakens the §12.5 "not marking its own homework" backstop — the
builder and reviewer were the same model instance. **Human owner: consider
re-running this gate with the Opus agent once budget allows.**

**Scope reviewed:** commit `8deec6b` plus lint fixes, against SPEC §2, §3, §4,
§9, §10 (Phase 1 row), §12. `npm test`: 28/28 green. Fixture regeneration
verified byte-identical against committed files.

## MUST-FIX

(none)

## SHOULD-FIX

1. **Determinism test is indirect.** `test/fixtures.test.ts` ("fixture
   regeneration is deterministic") only greps `scripts/gen-fixtures.mjs` for
   `Date.now`/`Math.random`; it does not regenerate and byte-compare. The
   sha256 test partially covers statements but not expected JSONs or the
   ledger. Add a true regenerate-into-tempdir-and-diff test in Phase 2.
   (SPEC §2.4 golden-test spirit.)
2. **§9 pre-commit PII grep hook not yet installed.** §10 schedules pre-commit
   hooks for Phase 4, but commits began in Phase 1 and §9 frames the staged-file
   grep as a from-the-start rail alongside the day-zero gitignore. Risk is low
   while all data is synthetic, but install it at Phase 2 start (when real-ish
   parsing work begins), not Phase 4.
3. **Fixtures are .txt, not PDF.** §5 defines `meridian ingest <pdf>`. Deferral
   is reasonable (no ingestion pipeline exists to consume PDFs yet) and is
   logged in PROGRESS.md, but rendering fixtures to PDF (or formally admitting
   a text ingest path for fixtures) must be an explicit Phase 2 entry task, or
   §5 acceptance criteria cannot be exercised end-to-end.

## NOTE

- ajv `strictRequired` is disabled (that sub-flag only) because the ledger
  schema's source-or-manual `anyOf` names properties defined on the parent
  subschema. Documented in the test and PROGRESS.md. Acceptable.
- US 2026 params: inflation-adjusted figures marked `"projected"` with basis
  stated — conforms to §2.3 versioning; refresh when IRS Rev. Proc. publishes.
- Harcourt fixture prints a blended GBP total from USD lines using the
  statement's printed FX rate; expected parse output correctly preserves native
  currencies per line. Good realism for the §6.1 dual-currency work.
- Wrapper matrix keys are test-enforced to equal the ledger schema's wrapper
  enum — nice schema/params parity guard.
- `npm run lint` initially failed on the empty `src/` glob; fixed to `eslint .`
  during review. Two unused helpers removed from the generator; regeneration
  confirmed byte-identical after the edit.
- Layout conforms to §3; `data/` gitignored from commit 0; `.claude/settings.json`
  deny-list matches §12.3 verbatim including the vault read-deny.

**Verdict:** Phase 1 acceptance gate (npm test green on schema + params
round-trip) is met, with 0 MUST-FIX, 3 SHOULD-FIX (all scheduled into Phase 2
entry), 6 notes. Phase 2 may open.
