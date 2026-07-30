# PHASE REVIEW 2 — Ingestion pipeline (SPEC §5)

**Reviewer:** Opus structural-reviewer subagent (SPEC §12.1).
**Scope reviewed:** commits `a1f80a8` (Phase 2.0 entry tasks) and `a0a97f2`
(ingestion pipeline), against SPEC §2, §3, §5, §9, §12.
**Verification run:** `npm test` 45/45 green; `npm run lint` clean;
`npm run typecheck` clean. Pre-commit scanner exercised directly against probe
files. Golden ledger inspected (6 accounts, 10 instruments, 54 holdings,
25 transactions, 15 documents, 3 fx observations).

**Headline:** the three §5 Phase-2 acceptance criteria are met and demonstrably
tested. The gaps below are in parts of the §5 flow that the acceptance criteria
do not directly measure — the accept decision model, fuzzy-match confirmation,
and the breadth of the redaction pass.

---

## MUST-FIX

### M1. The accept flow accepts everything, and logs nothing (§5.6)

`acceptRun(ledger, run, config, ids)` — `src/ingest/accept.ts:99` — takes no
per-line decisions. It walks `run.output.accounts` and pushes every holding,
cash balance, fee and movement into the ledger unconditionally
(`accept.ts:142-195`). §5.6 requires: *"operator accepts/edits/rejects
line-by-line. Only accepted lines enter `ledger.json`."* There is currently no
representation of a rejected or edited line anywhere in the pipeline. The test
comment at `test/ingest-pipeline.test.ts:24` ("operator accepts every line")
describes the only path that exists.

Second half of the same sentence: *"Every acceptance is logged with timestamp."*
No timestamp is written. `ledger.documents[]` (`accept.ts:104-112`) carries
`id, filename, sha256, institution, doc_type, period, parse_run_ids` and no
date; grep of `schema/ledger.schema.json` finds no acceptance/parse-date field,
and grep of `test/golden/ingested-ledger.json` finds zero occurrences of
`accept` or `timestamp`. This also pre-empts §8 report section 6, which is
specified as *"every figure's source document **and parse date**"* — that field
does not exist to render.

Required: a decision argument to `acceptRun` (per account/holding/fee/movement
line), and a persisted acceptance record carrying an ISO timestamp. Per §2 and
§6 the clock must be **injected**, not read in `src/` — pass `acceptedAt` in the
same way `ids` is passed today.

### M2. Fuzzy match candidates are computed, displayed, then silently discarded (§5.4)

`executeParseRun` attaches `matches` to the run (`src/ingest/run.ts:43`) and
`renderReviewHtml` renders `status = "confirm match"` for them
(`src/ingest/review-html.ts:35-37`). But `acceptRun` never reads `run.matches`.
`resolveInstrument` (`src/ingest/accept.ts:60-81`) redoes an identifier-only
lookup and, on a miss, unconditionally pushes a **new draft instrument**
(`accept.ts:69-79`).

Consequence: an operator who confirms a fuzzy candidate in the review file has
no mechanism to record that confirmation, and the instrument they just confirmed
is duplicated in the ledger rather than merged. §5.4's "fuzzy name match proposes
candidates (never auto-accepts)" is only half-implemented — the proposal exists;
the acceptance of a proposal does not.

This is invisible to the suite because `test/ingest-pipeline.test.ts:69-94`
exercises `matchInstruments` in isolation against a synthetic probe, never
through `acceptRun`.

Required: `acceptRun` must consume the operator's match decision (confirm
candidate *X* / create new draft / reject line) and route to the confirmed
instrument id when one is given. A regression test must ingest a
name-only-matching holding through the full accept path.

### M3. Redaction is closed-vocabulary; `assertRedacted` shares the blind spot (§5.2, §2.2)

`redactStatement` substitutes person names only where the exact string is
enumerated in `vault.persons` (`src/ingest/redact.ts:42-44`, populated from
`household-config.persons[].names`). `assertRedacted` then checks for *the same
enumerated strings* (`redact.ts:66-72`). A personal name that is not in the
vault — a surname on its own, `E. Vance`, a joint holder, an adviser, a
beneficiary, an executor, a trustee — is neither redacted nor detected, and the
gate returns clean. `extractWithClaude` (`src/ingest/extract-llm.ts:60`) then
transmits it to the API.

Structural identifiers are handled well: `ACCOUNT_RE`, `NI_RE`, `SSN_RE`,
`POSTCODE_RE` (`redact.ts:23-26`) are both substituted and asserted, and the
§5.2 hard-fail on a surviving raw account-number pattern is correctly
implemented and correctly tested (`test/ingest-redact.test.ts:43`). §5.2 however
specifies *"Local regex **+ NER pass**"*, and §2.2 makes privacy-by-construction
non-negotiable. Today the guarantee is "no *enumerated* PII egress", not "no PII
egress" — and the operator, not the system, is the control.

Required (minimum acceptable): a deterministic unknown-proper-noun heuristic
that runs inside `assertRedacted` and hard-fails before egress — e.g.
capitalised-token bigrams that are not on an allowlist of institution names,
instrument names, and month/place tokens already present in the document
vocabulary. A trained NER model is **not** required for v0; a detector that
fails loudly and forces the operator to extend the vault is sufficient and keeps
`src/` deterministic.

---

## SHOULD-FIX

### S1. The §9 pre-commit rail is not reproducible from the repo

`.git/hooks/pre-commit` exists and is executable, but `.git/hooks/` is not
version-controlled, `git config core.hooksPath` is unset (verified), and nothing
in `package.json`, `README.md` or `CLAUDE.md` installs it — grep for
`hook|pre-commit|precommit` across those three files returns only the
`npm install` line in `README.md:35`. Any fresh clone, worktree, or
re-initialised repo runs with the §9 rail silently absent. Add a tracked
`.githooks/pre-commit` plus `"prepare": "git config core.hooksPath .githooks"`
in `package.json`, and document it in the README.

### S2. The scanner omits §9's headline pattern

§9 specifies the hook greps for *"ISIN-adjacent account patterns and common name
tokens from the vault"*. `scripts/precommit-scan.mjs:13-17` covers UK NI, US
SSN, and sort-code+account, plus vault strings. Verified behaviour: a file
containing `ALD-4471902` — precisely the shape `ACCOUNT_RE`
(`src/ingest/redact.ts:23`) exists to catch — passes with exit 0, while an NI
probe correctly exits 1. The tension is real (the committed synthetic statements
legitimately contain that shape), so the fix is the account pattern **plus** an
explicit `test/fixtures/**` allowlist, not omission.

### S3. The §9 vault rails have zero test coverage

`saveVault` / `loadVault` (`src/ingest/redact.ts:79-86`) are exported and called
by no test, script, or module (verified by repo-wide grep). Nothing asserts the
mode-600 write, the `data/{household}/vault.local.json` location required by
§5.2, or that the path is gitignored. Separately, `writeFileSync(path, data,
{ mode: 0o600 })` applies the mode **only on creation** — re-saving over an
existing vault with looser permissions silently leaves them. Follow the write
with an explicit `chmodSync(path, 0o600)` and cover both in a test.

### S4. The low-confidence review path is dead code in the suite (§5.5)

`review-html.ts:13,38,45,86` implement the `<0.9` treatment §5.5 calls for. But
`parseFixtureStatement` emits only the fixed constants at
`src/ingest/extract-fixture.ts:35` (0.97 / 0.98) — verified: no expected fixture
contains any confidence below 0.9. The single review test
(`test/ingest-pipeline.test.ts:118-138`) therefore never exercises the branch,
the `.low` border, or the page-image substitute note. Add a synthetic
low-confidence run to that test.

### S5. Cash balances and FX observations carry no confidence (§5.5)

§5.5: *"Every extracted figure carries a confidence score."*
`schema/parse-output.schema.json:92` types `cash_balance` as a bare
`$defs/money`, and `source.fx_rates` items (`:34-43`) have no confidence
property. Both become ledger figures — cash as a holding
(`accept.ts:158-167`), FX as an `fx_rates` row (`accept.ts:114-121`) — and the
cash line renders in the review file with no confidence chip
(`review-html.ts:51`). Cash is often the largest single line on a private-bank
statement; it should not be the one figure with no score.

### S6. `needs_review` is set on every created instrument, so it carries no signal (§5.4)

`accept.ts:76` flags every draft `needs_review: true`, including instruments
created from a clean, unambiguous ISIN. Result: 8 of 8 non-cash instruments in
`test/golden/ingested-ledger.json` are flagged. §5.4 reserves the flag for
*"Unknown instruments"*. The pipeline assertion
(`test/ingest-pipeline.test.ts:102`) is `drafts.length >= 8`, which by
construction cannot distinguish "flagged because unknown" from "flagged because
everything is flagged". Either narrow the flag to identifier-less/fuzzy-matched
instruments, or add a second field for "metadata unconfirmed" and let
`needs_review` mean what §5.4 says.

### S7. Heuristic `type` / `domicile` inference feeds the §7.1 PFIC cascade

`inferType` (`accept.ts:17-33`) classifies instruments by name regex. An
Irish-domiciled ETF whose name omits the word "UCITS" falls through
`/\betf\b/i` to `us_etf`. `domicile` (`accept.ts:74`) is set to the ISIN prefix,
which is the issuing CSD, not the fund's domicile. Neither `us_registered` nor
`hmrc_reporting_fund` is ever populated — yet §7.1's *first* cascade rule keys
on `us_registered == true → NOT PFIC`, and its "non-US domiciled pooled vehicle"
branch keys on domicile. A misclassification here silently downgrades a CRITICAL
PFIC flag. Phase 3 must not treat ingest-inferred `type`/`domicile` as
authoritative: gate the cascade on operator-confirmed instrument metadata and
route anything unconfirmed to §7.1's `needs_classification` outcome.

### S8. Parked and review artefacts are never written to disk (§5.3, §5.5, §3)

§5.3 requires a twice-invalid extraction to land in `parse-runs/failed/`; §5.5
requires the run to *produce* a REVIEW file. `ParkedError`
(`extract-llm.ts:24`) and `renderReviewHtml` return values only — nothing in
`src/ingest/` writes to `data/{household}/parse-runs/`, and that §3 directory is
unpopulated. Deferring file placement to the Phase 4 CLI boundary is defensible,
but it must be an explicit Phase 4 entry task in PROGRESS.md, exactly as the
Phase 1 SHOULD-FIX items were carried into Phase 2 — otherwise §5's flow ships
half-delivered.

### S9. `Ledger` is `any[]` for six of its eight collections

`src/ingest/types.ts:89-94` types `accounts`, `instruments`, `holdings`,
`transactions`, `documents` and `fx_rates` as `any[]`. §2.1's "deterministic,
unit-tested TypeScript" core loses compile-time protection precisely where the
canonical model matters most: `npm run typecheck` passes vacuously over the
whole of `accept.ts`. The schemas are the source of truth, but the types should
mirror §4 rather than opt out.

### S10. `npm test` enumerates test files by hand

The `test` script in `package.json` lists all six suites explicitly. A new
`test/*.test.ts` that nobody remembers to add runs green by not running at all —
a bad failure mode for a project whose phase gate is "tests pass". Use a glob
(`node --import tsx --test "test/**/*.test.ts"`).

---

## NOTE

- **All three §5 Phase-2 acceptance criteria verified.** (a) byte-for-byte:
  `test/ingest-parse.test.ts:12` compares serialized parser output against all
  15 committed expected files, over one shared vault in the documented
  `INGEST_ORDER` so token allocation is part of the contract. (b) redaction
  failing test: `test/ingest-redact.test.ts:57` asserts `fetch` was called 0
  times and 0 audit rows written when raw text is passed to
  `extractWithClaude`. (c) NETWORK_AUDIT: `:79` asserts one row per call with
  endpoint/timestamp/`redaction_check: pass`, and `:104` asserts two rows across
  the single retry.
- **§2 determinism verified.** Repo-wide grep of `src/` finds no `Date`,
  `Date.now`, `new Date`, `Math.random`, or `process.env`. Clock and randomness
  are injected through `ulidFactory(now, random)` (`src/ingest/ids.ts:14`), and
  the API key is a parameter (`extract-llm.ts:41`), not an env read. AI sits
  strictly at the edge: `extract-llm.ts` and the fuzzy proposals in `match.ts`;
  no LLM output becomes a computed number.
- **File sizes conform to §10.** Largest files: `scripts/gen-fixtures.mjs` 469,
  `src/ingest/accept.ts` 201, `src/ingest/extract-fixture.ts` 184. All under 500.
- **PHASE_REVIEW_1 SHOULD-FIX items are genuinely resolved.** (1) A true
  regenerate-into-tempdir-and-byte-compare test now exists in
  `test/fixtures.test.ts` and passes (~52ms), covering statements, expected
  JSONs and the fixture ledger. (2) The hook is installed and verified blocking
  — residual gaps are S1/S2, not a failure to do the work. (3) The text-ingest
  decision is formally recorded (PROGRESS.md step 2.0: `.txt` natively, `.pdf`
  converted at the Phase 4 CLI boundary).
- **`.claude/settings.json` matches §12.3 verbatim**, including
  `Edit(./test/golden/**)` and the vault read-deny. Worth noting the deny is
  Edit-only: `npm run gen:golden` (`scripts/gen-golden-ingest.mts`) rewrites the
  golden ledger through `Bash(node:*)`, which is on the allow list. The script
  header warns against casual use; consider requiring an explicit `--force` flag
  so the §12.5 "not marking its own homework" backstop is not one command away.
- **Audit rows are appended before the fetch resolves**
  (`extract-llm.ts:79-85`), so a row records an *attempted* call. This is the
  conservative reading of §2.2 and correct. Two small consequences: a `!res.ok`
  response sets `priorErrors = "API error: HTTP nnn"` (`:101`) which the retry
  prompt then labels as a schema-validation failure (`:71`); and a thrown fetch
  (transient network error) propagates raw rather than parking the document.
- **`vault.salt` is stored but never used** (`redact.ts:37`). Tokens are
  sequential `A1..An` and person tokens come from config, so §5.2's "salted
  tokens" is satisfied in spirit — sequential tokens carry no recoverable
  information — but the field is inert. Either derive tokens from it or drop it
  so the vault does not imply a property it does not have.
- **`test/fixtures/household-config.json` holds fictional names and an address
  in the repo**, correct per NOTICE and clearly labelled. Note that the
  scanner's vault check only reads `data/**/vault.local.json`
  (`precommit-scan.mjs:20-40`), so a *production* household config committed by
  mistake would not be caught. Fold config paths into the scan when the CLI
  lands.
- **`run.ts` and `extract-llm.ts` each independently read and ajv-compile
  `parse-output.schema.json` at import time** (`run.ts:14-16`,
  `extract-llm.ts:12-15`). Harmless; one shared validator module would be
  tidier and guarantees the two paths cannot drift.
- **Review HTML conforms to what §5.5 asks of it.** 390-first, self-contained,
  no external assets, §8 palette (`#FAFAF7` / `#101B2D` / `#8C7A3F`),
  tabular-lining numerals, ≥24px chips, `prefers-color-scheme` block, HTML
  escaping verified, prior-vs-proposed diff for matched holdings, and the §9
  footer disclaimer. It has no accept/reject controls — correct; that is
  `meridian review` in Phase 4. §8's hard budgets (Lighthouse, 400KB, PWA)
  are Phase 5's gate, not this one.
- **Ledger quality spot-check.** The golden ingested ledger validates against
  `schema/ledger.schema.json`, reconciles per-account and per-currency against
  the independently generated Phase 1 fixture ledger, ties every document's
  sha256 to the *raw* (pre-redaction) bytes, and correctly resolves the Atlas
  UCITS ETF appearing across three accounts and nine documents to a single
  instrument with accumulating price points. The Sterling Park MiFID
  disclosures correctly attach to the Harcourt-custodied A5 by shared raw
  account number — a good cross-institution wiring test.

---

**Verdict:** Phase 2 hits its three stated §5 acceptance criteria cleanly and
the tests that prove them are honest ones — the byte-for-byte comparison is
genuinely byte-for-byte, the redaction failing test asserts on call *count* not
just on the throw, and the determinism/regeneration gap from Phase 1 is properly
closed. What is missing sits in the parts of §5 the acceptance criteria do not
measure: the accept step has no decision model and writes no timestamped
acceptance record (§5.6), the fuzzy-match proposals it renders can never be
acted upon and instead duplicate instruments (§5.4), and the redaction gate is a
closed vocabulary that cannot see a name the operator forgot to list (§5.2,
§2.2). Those three block the gate; the rest are real but schedulable, with S1/S2
(pre-commit rail reproducibility and the missing account pattern) worth pulling
forward because they are §9 day-zero rails and cheap. **3 MUST-FIX, 10
SHOULD-FIX, 9 NOTE — Phase 3 must not open until M1–M3 are resolved and
`npm test` is re-run green.**
