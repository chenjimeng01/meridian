# PHASE REVIEW 4 — Operator CLI (SPEC §10 Phase 4)

**Reviewer:** Opus structural-reviewer subagent (SPEC §12.1).
**Scope reviewed:** commits `cf496d1` (S13) and `0e1fdfe` (Phase 4) against
SPEC §2, §3, §5, §6.3, §7, §9, §10 Phase 4 row, §12. Working tree clean
(`git status --porcelain` empty), so this reviews exactly the committed state.

**Verification run:** `npm test` 140/140 green; `npx tsc --noEmit` clean;
`npm run lint` clean. Beyond re-running the suite I drove the real binary
end-to-end from a shell into a throwaway data root — `households create`,
15 × `ingest --offline`, 15 × `review --accept-all --confirm-metadata`,
`report --asof 2026-06-30` — and then inspected the resulting ledger, vault,
file permissions and results JSON. I also wrote three throwaway probe scripts
against `src/cli/commands.ts` to test id collision, parked-run reuse and
review idempotency directly. Every measured figure quoted below came out of one
of those runs; nothing here is inferred.

**Headline:** the CLI is real, the layout matches §3, `--offline` genuinely
prevents egress, §2 determinism holds exactly as declared, and the two bugs the
main loop found itself (S13 metadata confirmation, Module 3 snapshot
double-counting) are both correctly and completely fixed — the Module 3 fix in
particular reconciles to the penny against the consolidation on a live
multi-snapshot ledger, and the S13 test suite is genuinely adversarial. But the
Phase 4 gate is not met as written and should not be signed off yet. The "pdf"
leg of the gate has never executed even once (no PDF exists in the repo,
`pdftotext` is not installed on this machine, and no test reaches that branch);
the run-id collision fix is **incomplete** — I reproduced a wholesale
run-id/ledger-id namespace collision inside `test/cli.test.ts`'s own acceptance
scenario; `meridian review` silently double-applies an already-accepted run;
and the results JSON's §6.3 cost stack reports a multi-year fee total as an
annual rate (226.92 bps against a true 141.22) with every category collapsed to
"platform", then compounds that rate for twenty years. The results JSON also
omits §6.2 performance and benchmarks entirely, which PROGRESS.md step 4.6 does
not disclose.

---

## MUST-FIX

### M1. The gate's "pdf" leg has never executed, and the PDF path is wrong where it exists

SPEC §10 Phase 4 acceptance gate: *"end-to-end: **pdf** → accepted ledger →
results JSON on fixture"*. §1 is built on the same premise (*"uploads their
custodian/platform/bank statements as PDFs"*).

Measured:

- `find . -name '*.pdf' -not -path './node_modules/*'` → **zero results**. There
  is no PDF anywhere in the repository.
- `grep -rn "\.pdf" src/ test/` → **three hits, all in
  `src/cli/commands.ts:81,83,86`**. No test file mentions a PDF.
  `readDocument`'s PDF branch (`commands.ts:82-88`) has zero coverage.
- `which pdftotext` → **not installed** on this machine. The branch has
  therefore never run, not once, during the build.
- `test/cli.test.ts:13-15` nevertheless states the gate verbatim as *"pdf →
  accepted ledger → results JSON"* in its header comment, while the test it
  labels is named `"END TO END: statements → accepted ledger → results JSON"`
  (`:141`). The test is honest; the header above it is not.

Two independent defects sit inside the untested branch:

1. **`sha256` is taken over the converted text, not the file.**
   `commands.ts:100-101` computes the hash from `readDocument`'s *output*.
   §5.1 says *"Hash file"* and §4 puts `sha256` on `documents[]` as the
   document's fingerprint. Two different PDFs that render to identical text
   collide; the same PDF re-ingested after a poppler upgrade changes hash and
   re-enters as a new document; and the hash cannot be used to verify the file
   the operator actually received.
2. **`documents/` does not hold the raw PDF.** `commands.ts:102` passes
   `rawText` (the converted text) to `storeDocument`, and `store.ts:111-113`
   derives the extension from the *original* filename — so a PDF ingest writes
   plain text to `data/{household}/documents/<sha>.pdf`. §3 labels that
   directory *"raw uploaded PDFs"*. The audit trail claims to hold the source
   document and holds a lossy rendering mislabelled as one.

Also, `commands.ts:84-88` catches every `execFileSync` failure and reports
*"'pdftotext' is not available"* — a corrupt PDF, an encrypted PDF, or a
non-zero exit all produce that same wrong message.

**Required:** either render at least one fixture statement to PDF and drive the
gate through it (which also proves `parseFixtureStatement` survives
`pdftotext -layout` whitespace, currently unknown), or amend the gate wording in
SPEC §10 / PROGRESS.md as a deliberate, dated decision the way step 2.0 did for
text ingest. Fix the hashing and the stored-extension defects either way — they
are wrong regardless of which route is taken.

### M2. The `ledgerIds` collision fix is incomplete: run ids and ledger ids still share a namespace

The counter scheme itself is sound. I tried to break it and could not: each
factory's counter starts at `seen.size`, which provably exceeds the highest
counter any earlier factory allocated *provided every persisted id is in
`seen`*, and the `do { } while (seen.has(candidate))` loop at `ids.ts:52-56`
rejects any survivor. Rejected lines allocate nothing (`accept.ts:249-252`
returns before `resolveInstrument`), so a rejection cannot cause reuse either.
The scheme's only failure mode is a **persisted id the factory cannot see** —
and there are still two of those.

**(a) `cmdReview` never seeds run ids.** `commands.ts:244` calls
`ledgerIds(ledger, acceptedAt)` with no `alsoSeen`, and `collectIds`
(`ids.ts:21-29`) never collects `documents[].parse_run_ids`. So run ids on disk
are invisible to every review. Combined with `main.ts:69`, which truncates the
clock to whole seconds (`replace(/\.\d{3}Z$/, "Z")`), the collision window is a
full **second**, not a millisecond.

Reproduced under `test/cli.test.ts`'s own clock (`CLOCK` at `:23-25`, which
returns `2026-07-30T12:00:00Z` for every call after the first), running the
exact acceptance sequence:

```
ledger ids: 49   unique: 49
run ids that are ALSO ledger ids:  [ all 15 of them ]
document whose own id equals its parse run id: 01KYSEAKG00000000000000004  valuation-2025-12.txt
```

Every one of the fifteen parse-run directory names is simultaneously in use as
an account, instrument, document or acceptance id, and `documents[0].id ===
documents[0].parse_run_ids[0]`. §4 states *"All IDs are ULIDs"*; the ledger's
whole value proposition (§2.6, §5.6) is that it is auditable, and an id no
longer names one thing. `test/cli.test.ts` asserts nothing about id uniqueness,
so the acceptance test both causes and hides this.

**(b) Parked run ids are reused and overwrite each other — data loss.**
`store.ts:127-134` `listRuns()` filters out `failed` and does not descend into
it, so the ids of parked runs are never seeded anywhere. The park path
(`commands.ts:123-131`) allocates `ids()` from that same blind factory.
Reproduced with two different unparseable documents ingested in the same second:

```
parked: 01KYSEAKG00000000000000004
parked: 01KYSEAKG00000000000000004
failed dir entries: [ '01KYSEAKG00000000000000004' ]
```

The second park **silently overwrote the first's `error.txt` and `source.txt`**.
§5.3 exists precisely so an unparseable document is *"parked … for manual entry
rather than silently dropped"*; here it is silently dropped. This is the same
class of bug the Phase 4 commit message claims to have closed, still live on
the path that matters most.

**Required:** seed `alsoSeen` from *both* `parse-runs/*` and
`parse-runs/failed/*` on every path that mints ids (ingest, live ingest, review,
park), and add `documents[].parse_run_ids` to `collectIds`. Pin it with a test
that asserts the union of ledger ids and on-disk run ids has no duplicates under
a single fixed timestamp — that is the assertion that would have caught this.
Consider also keeping sub-second precision in `main.ts:69`; the truncation buys
nothing and widens every window a thousandfold.

### M3. `meridian review` is not idempotent — re-reviewing an accepted run double-applies it

`cmdReview` (`commands.ts:239-302`) reads the run, calls `acceptRun` and saves.
Nothing checks whether that run was already accepted. `acceptRun`
(`accept.ts:182-362`) unconditionally pushes a new document, a new acceptance,
new holdings, new fee/movement transactions and new `fx_rates` rows.
`RunMeta.accepted?: boolean` is **declared** at `store.ts:42` and is never
written and never read.

Measured on a live ledger by re-running `meridian review <run-id> --accept-all`
on two already-accepted runs:

| | before | after |
|---|---|---|
| `documents` | 15 | 17 |
| `holdings` | 54 | 61 |
| fee transactions | 16 | 20 |
| `acceptances` | 15 | 17 |
| `costStack.total.amount` | £4,133 | **£5,291** |
| `costStack.total.bps` | 226.92 | **290.50** |
| `appendix.documents` | 15 | 17 |

The consolidated total did not move — but only by luck: `latestHoldings`
(`consolidate.ts:56-65`) dedupes by `(account, instrument)` and the duplicate
rows carry an identical `asof`, so one is discarded. Transactions have no such
protection, so the §6.3 headline moves by the full duplicated amount, and the
§8 data appendix lists the same document twice with two different ids.

A single accidental re-run — a shell history repeat, a script retry, a resumed
autonomous session — silently corrupts the client's cost figures with no error
and no warning. §5.6: *"Only accepted lines enter `ledger.json`. Every
acceptance is logged with timestamp."* The model is one acceptance per run;
nothing enforces it.

**Required:** record acceptance on the run (write `accepted: true` plus the
resulting `document_id` into `run.json`, or check
`ledger.documents.some(d => d.parse_run_ids.includes(runId))`) and refuse
by default, with an explicit `--reaccept` that first reverses the prior
acceptance. Test it.

### M4. The §6.3 cost stack presents a multi-year fee total as an annual rate, then compounds it for 20 years

`results.ts:109-112` selects **every** fee transaction with `t.date <= asof` —
no period window at all — and hands the lot to `costStack`. On the fixture
household that is four years of charges. Measured from the live results JSON:

```
costStack.total          £4,133   226.92 bps
  A3   £765    78.15 bps   (SIPP charges 2024-04-05, 2025-04-05, 2026-04-05)
  A5   £3,368 399.83 bps   (MiFID disclosures for 2023, 2024 and 2025)
compoundingDrag.assumption
  "growth at 5.00% a year less an ongoing charge of 2.27% applied to the
   whole portfolio each year, with no contributions or withdrawals"
compoundingDrag.drag     £415,690.65 on a £442,559.54 portfolio
```

§6.3 requires *"total **annual** £ and bps"*. The engine is right — the
2025 MiFID disclosure alone is £1,158.00 / 141.22 bps, the golden figure Phase 3
reconciles to the penny — and the CLI adapter is wrong by roughly a factor of
three. `results.ts:123-128` then feeds `stack.total.bps / 10_000` into
`compoundingDrag` as `annualFeeRate`, so the twenty-year projection compounds
2.27% instead of ~1.4%, producing a £415,690 "drag" that is not a real number.

A second inconsistency sits in the same call: `stack.total.bps` is computed
against `stack.totalBase` — the summed average values of the two accounts that
*have* fees, ≈£182,133 (`4133 / 182133 × 10000 = 226.9`) — while
`compoundingDrag` applies that rate to `consolidation.total.base`, the whole
£442,559. A rate measured on 41% of the portfolio is applied to 100% of it.

`test/cli.test.ts:176` asserts only `results.costStack.total.amount.currency ===
"GBP"`, which is why nothing caught any of this. §6.3 calls this screen *"the
yTree-killer moment; make it exact and sourced"*.

**Required:** window the fee selection to a stated annual period (and label it),
compute the bps denominator on the same basis the drag is applied to, and assert
the actual figure in the end-to-end test.

### M5. The §6.3 category breakdown is destroyed by the ledger round-trip — everything reports as "platform"

The parse output carries the §6.3 categories correctly. From
`test/fixtures/expected/sterling-park-wealth/mifid-costs-2025.json`:

```
Discretionary management fee      platform     £820   100 bps
Underlying fund ongoing charges   fund_ocf     £198    24 bps
Transaction costs                 transaction   £88
Foreign exchange spreads          fx_spread     £52
```

`accept.ts:319-327` writes fees into `ledger.transactions` with **no `category`
and no `label`** — `schema/ledger.schema.json`'s transaction item has no field
for either (`account_id, date, type, instrument_id, units, gross, fees, net,
source_document_id, source, operator_initials`). `results.ts:110-116` then
fabricates replacements: `label: "Charges ${t.date}"`, `category: "platform"`,
for every fee without exception. The live results JSON:

```
costStack.byCategory  {"platform":{"amount":{"amount":4133,"currency":"GBP"},"bps":226.92}}
```

The report therefore tells a client that 100% of their costs are platform costs,
when the source documents say a quarter of them are fund OCF, transaction costs
and FX spreads. §6.3 names five categories explicitly (*"ongoing
product/platform %, fund OCF …, advice fees, transaction costs, FX spreads where
visible"*) and §6.3's own standard is *"every number traceable to a document"* —
the category here is traceable to a literal in `results.ts`.

The engine is not at fault: `costStack` handles categories correctly and
`test/engine-cost.test.ts` exercises real ones. The loss is at the ledger
boundary.

**Required:** add `category` (and the disclosed `label`) to the transaction
schema and to `accept.ts`, and read them in `results.ts`.

### M6. The results JSON omits §6.2 entirely, and PROGRESS.md says otherwise

`Results` (`results.ts:21-49`) is `meta, consolidation, risk, costStack,
compoundingDrag, usConnect, appendix, warnings, disclaimer`. `results.ts:8-12`
imports `consolidate`, `assessRisk`, `costStack`, `compoundingDrag`, `convert`
and `analyseUsConnect` — and nothing from `src/engine/performance.ts` or
`src/engine/benchmark.ts`. There is no TWR, no Modified Dietz, no XIRR, no
benchmark composite, no real return, and no method label anywhere in the
Phase 4 output.

`src/engine/benchmark.ts` (162 lines) exists solely because PHASE_REVIEW_3 M4
required §6.2's benchmark and real-return reporting to be built rather than
silently dropped. Phase 4 then dropped it silently at the next layer.

PROGRESS.md step 4.6 states: *"`meridian report`: runs **the whole engine** +
Module 3 into a results JSON with the §8 data appendix"*. That is not accurate,
and the omission is recorded nowhere. §8 report section 3 (*"Performance vs
benchmark, labelled by method (TWR/Dietz)"*) is Phase 5's to render — it cannot
render what the results JSON does not contain, and this is the exact shape of
PHASE_REVIEW_3 S7 (*"nothing maps holdings + transactions into
`Valuation[]`/`Flow[]`"*), which was flagged then as *"Phase 4's gate … cannot be
met until those adapters exist"*.

**Required:** build the ledger → `Valuation[]`/`Flow[]` adapter and add a
`performance` section (with its method label and benchmark comparison) to
`Results`, or record an explicit dated deferral in PROGRESS.md and correct the
step 4.6 claim. What is not acceptable is Phase 4 closing while PROGRESS.md
says the whole engine ran.

### M7. §9 rail: Phase 4 writes client identifiers outside the vault, unprotected

§5.2: *"Mapping stored ONLY in `data/{household}/vault.local.json` (gitignored,
**chmod 600**)."* §9: *"Vault file … never leaves disk."* Two Phase-4 writes
break the "only" and the mode.

**(a) `household.json` is a second, world-readable copy of the vault's contents.**
`store.ts:75` writes the operator's entire config — which is typed
`HouseholdConfig` and includes `persons[].names` and `addresses[]`
(`accept.ts:21-27`) — with no mode argument. Measured on disk:

```
-rw-r--r--  household.json      ← "Eleanor Vance", "Thomas Vance",
                                  "14 Larkspur Mews", "London W1U 0XX"
-rw-------  vault.local.json    ← the same four strings
-rw-------  documents/<sha>.txt
```

`vault.local.json` is separately gitignored by name (`**/vault.local.json`);
`household.json` is protected only by the blanket `data/` rule. The vault's
mode-600 rail is defeated by a plaintext duplicate sitting beside it. The
fixture config's own comment even asserts the opposite: *"In production this
file's PII lives only in `data/{household}/vault.local.json`."*

**(b) Parked runs store the raw, unredacted document at 0644.**
`commands.ts:126-130` writes `source.txt` with the pre-redaction `rawText`.
Measured:

```
-rw-r--r--  parse-runs/failed/<id>/source.txt
    Statement for Mrs Eleanor Vance
    14 Larkspur Mews
    London W1U 0XX
    Account ALD-4471902
```

The identical bytes in `documents/` are chmod 600 (`store.ts:115`). The park
path also never reaches `store.saveVault(vault)` (`commands.ts:134` is after the
re-throw), so any account token `redactStatement` allocated while parsing the
failed document is discarded — token stability across runs (§5.2 *"stable …
tokens"*) is not maintained on that path.

**Required:** write `household.json` without the name/address fields (they
belong in the vault only) or with mode 600 and a gitignore entry of its own;
chmod the parked `source.txt` to 600; persist the vault before re-throwing.

---

## SHOULD-FIX (new in Phase 4)

### S1. `meridian report` hard-fails outright when the §7.1 de-minimis threshold cannot be converted

`pfic.ts:95-99` converts a USD threshold via the injected FX
(`results.ts:137` → `convert(...).exact`), which throws `FxUnavailableError`
when no GBP/USD rate exists on or before `asof`. There is no catch anywhere up
the stack, so the **entire report** — all of §6.1, §6.3, §6.4 — is refused
because an optional §7.1 reporting nicety could not be priced.

Reproduced on a household with a US person and one accepted document:

```
FxUnavailableError: no USD->GBP rate available on or before 2026-06-30 …
    at assessPfic (src/usconnect/pfic.ts:95)
    at buildResults (src/cli/results.ts:130)
```

This is not an edge case: `fx_rates` are populated only from statements that
happen to print a rate (`accept.ts:207-214`), so a US-connected household is in
this state after ingesting its first one or two documents — which is exactly
when an operator wants to look at the output. The gate passes only because the
full 15-document fixture happens to include three GBPUSD observations.
`consolidate` already models the right behaviour (`consolidate.ts:150-158`
catches, warns and degrades). Do the same here.

### S2. `cmdReview` recomputes matches against the current ledger, not the one the operator reviewed

`commands.ts:281-290` rebuilds the `ParseRun` and calls
`matchInstruments(output, ledger)` against the ledger **as it is now**.
`saveRun` (`commands.ts:144-148`) persists `run.json`, `parse-output.json` and
`review.html` — but **not** `run.matches` — so the match set the operator saw
rendered into `review.html` cannot be replayed. If any other run was accepted in
between (the normal case: `ingest` all, then `review` all), an instrument that
was `new` or `candidates` at render time may now be `matched`, and
`resolveInstrument` (`accept.ts:110-137`) will silently bind the line to a
different instrument than the review file showed. The operator accepts what they
saw; the system applies what it recomputes. Persist `matches` in the run
directory and replay them.

### S3. Decisions are keyed by name, not by line — `kind` is declared and never read

`commands.ts:258`: `new Map((decisions.lines ?? []).map(l => [l.ref, l]))`.
The key is the display label alone. `DecisionsFile.lines[].kind`
(`commands.ts:212`) is declared in the interface and never consulted, and
neither `accountToken` nor `index` — both present on `LineRef`
(`types.ts:108-119`) — participates in the key.

Consequences: a reject of `"Thames Utilities PLC Ordinary 25p"` rejects that
holding in **every** account in the run (this is what
`test/cli.test.ts:117-127` actually does); a fee whose `label` equals a holding
name collides with it; and `--confirm-metadata` is keyed the same way
(`commands.ts:263`, `metadataByName[line.ref]`), so it cannot distinguish two
instruments that share a name. §5.6 specifies *"accepts/edits/rejects
line-by-line"*. Separately, `review.html` renders no stable line identifier at
all, so the operator has no key to quote except a name they must retype exactly.

### S4. The cost-base FX handling is loud about what it drops and silent about what it keeps stale

`results.ts:84-96` catches `convert` failures, drops the snapshot and warns.
That is the right call over refusing the whole report — but three things make
the resulting bps less honest than it looks:

- **Staleness is discarded.** `convert()` returns `warnings` and this loop never
  reads them, so a snapshot valued on a 30-day-old rate silently enters the fee
  base while a 32-day-old one is loudly dropped. The policy
  (`fx-policy.json`) warns beyond 7 days and refuses beyond 31; the cost base
  honours only the second half.
- **The warning fires for accounts that contribute nothing.** The live run
  emitted *"cost base for A4 excludes 1 snapshot(s) (2026-05-31)…"* — but A4 has
  no fees and is filtered out at `results.ts:119`, so the excluded snapshot
  affects no figure in the report. The operator is warned about a number that
  does not exist.
- **The denominator is invented, not sourced.** The MiFID fixture prints
  *"Average portfolio value over period: £82,000.00"*; `results.ts:108` uses the
  arithmetic mean of whatever snapshot dates happen to exist instead. That is
  PHASE_REVIEW_3 S6, still open, now with a live consequence in the headline bps
  (§6.3: *"every number traceable to a document"*).

### S5. The §6.3 growth assumption is a literal with no way to set it

`results.ts:18-19`: `DEFAULT_GROWTH_ASSUMPTION = 0.05`, `DRAG_YEARS = 20`.
§6.3 says *"a 20-year compounding-drag projection at **user** growth
assumption"*. `BuildResultsInput.growthAssumption` exists (`results.ts:59`) but
`cmdReport` never passes it (`commands.ts:315-320`) and `main.ts` exposes no
flag. The assumption is currently unsettable and appears in the output only
inside a prose string.

### S6. Params year selection is hardcoded and ignores `--asof`

`results.ts:132-133` always reads `us/2026.json` and `uk/2026-27.json`
regardless of the report date. §2.3 gives every params file an
`effective: {from, to}` range precisely so the right file can be chosen by date;
nothing resolves it. A report `--asof 2024-12-31` would silently apply 2026
parameters.

### S7. `NETWORK_AUDIT.md` is written relative to the current working directory

`commands.ts:165`: `join(process.cwd(), "NETWORK_AUDIT.md")`. Run the CLI from
anywhere but the repo root and the §9 egress log is appended to a different
file, leaving the tracked `NETWORK_AUDIT.md` with no record. §9 and §2.2 both
name the file as the audit record; it should be resolved from the module (as
`DEFAULT_PARAMS_ROOT` is at `results.ts:15`) or from the data root, not the cwd.

### S8. The `--offline` extractor is the *fixture* parser, mislabelled

`cmdIngest` reports `extractor: "deterministic (offline)"` (`commands.ts:154`),
but `executeParseRun` defaults to `parseFixtureStatement` (`run.ts:30`), which
recognises only the five synthetic layouts. An operator ingesting a real
statement with `--offline` gets a park, not a parse. That is the specced
behaviour (§9: *"parsing then requires manual entry mode"*, itself a Phase 6
deliverable) — the label is what misleads, in both the CLI output and the
`IngestResult` type.

### S9. The vault salt is set to the household id and is never used

`commands.ts:53` passes `householdId` as the salt; `redact.ts:97` stores it and
nothing reads it — tokens are sequential `P1`/`A1` (`redact.ts:110-113`).
§5.2 specifies *"stable **salted** tokens"*. The salt is currently a stored
value with no function, set to a string that is also the containing directory's
name. Either salt the tokens or record the simplification deliberately.

### S10. The per-run acceptance record on disk cannot be reconciled with the ledger

`commands.ts:298-300` writes `accepted.json` containing only
`{acceptedAt, accepted, rejected, edited, metadataConfirmed}` — no document id,
no run id, no decisions. `metadataConfirmed` also counts *lines*, not distinct
instruments (`commands.ts:270-271`), so the CLI reports "5 instrument metadata
confirmation(s)" for a run touching fewer than five distinct instruments. The
authoritative record is `ledger.acceptances[]`; this file is a summary that
cannot be joined back to it.

---

## Carried-forward PHASE_REVIEW_3 SHOULD-FIX — verified status

PROGRESS.md lists these as scheduled, not done. I checked each one individually.
**All eight named in the brief are still open**, two of them partially advanced:

| Item | Status | Evidence |
|---|---|---|
| **S1** unrounded floats leak into `usconnect` | **OPEN** | Live results JSON: `pfic.summary.investableWealthBase` `442559.5371875`, `situs.persons[0].usSitus.totalBase` `56688.7890625`, `wrapperConflicts[0].valueBase` `155319.83125`, `currencyOfLife.persons[0].totalBase` `357047.2715625`. Nothing in `src/usconnect/` rounds. |
| **S2** `Math.round` where the policy mandates half-even | **PARTLY DONE** | `consolidate.ts:161` now uses `roundHalfEven`. `risk.ts:70`, `:91`, `:92` still use `Math.round(x * 100) / 100`. |
| **S3** `convert()` rounds inside the engine | **PARTLY DONE** | `FxResult.exact` added (`fx.ts:31`) and used by `consolidate.ts:105` and `results.ts:85,137`. `convert()` still rounds `amount` (`fx.ts:130`, `:154`) and `toCurrency` (`fx.ts:171-173`) still returns the rounded value. |
| **S4** hardcoded USD pivot, unread policy values | **OPEN** | `fx.ts:140` `const pivot = "USD";`. `cross_rate_rule` and `rate_decimal_places` are still typed at `fx.ts:48-49` and never read. |
| **S6** cost reconciliation against hand-typed constants | **OPEN** | `test/engine-cost.test.ts:12-13` still `DISCLOSED_TOTAL = 1158.0` / `AVERAGE_VALUE = 82000.0`; `schema/parse-output.schema.json` still has no `disclosed_total` / `average_value`. Now has a live consequence — see S4 above. |
| **S7** only two engine entry points take a ledger | **PARTLY DONE, WRONG LAYER** | A ledger→`CostStackInput` adapter now exists, but inline in `src/cli/results.ts:78-121` rather than in `src/engine/`. No ledger→`Valuation[]`/`Flow[]` adapter exists at all — which is M6. |
| **S8** `latestHoldings` disposal + staleness semantics | **OPEN, AND NOW HIGHER-STAKES** | `consolidate.ts:56-65` unchanged. Because `buildPositions` now shares it (`ledger-view.ts:94`), a disposed position that vanished from later statements would inflate the PFIC exposure table, the critical count *and* the situs table, not just the consolidation. Live evidence of the staleness half: account A3's latest snapshot is `2026-04-05` and is included silently in a `2026-06-30` report; §8 section 1 requires *"data-freshness per account"* and the results JSON carries none. |
| **S9** the two currency columns are two measurements | **OPEN** | `consolidate.ts:104` converts each holding at `holding.asof`; `:149-159` converts slices and the headline at the report `asof`. No warning states it. |
| **S10** concentration per-instrument, against total wealth | **OPEN** | `risk.ts:47-54` unchanged (`slice.shareOfTotal > threshold` over `byInstrument`). |
| split `pfic-rules.json` | **OPEN** | §7.3 situs and §7.4 currency-of-life config still live there. |

**S5, S11, S12 and S13 are genuinely closed** — S5/S11/S12 at `9a780c6`, S13 at
`cf496d1` (see the NOTE below).

---

## NOTE

- **The Module 3 snapshot fix is correct and complete.** `buildPositions`
  (`ledger-view.ts:94`) now takes `latestHoldings(ledger, asof)` and converts at
  `String(holding.asof ?? asof)` (`:113`) rather than the report date, exactly
  as the consolidation does. Verified live rather than only via the test: on the
  15-document ledger, `pfic.summary.investableWealthBase` = `442559.5371875`
  against `consolidation.total.base.amount` = `442559.54`. The semantics are
  right for both consumers — PFIC exposure and situs both want one row per
  current position valued on the date it was struck. The regression test
  (`ingest-to-usconnect.test.ts:140-171`) is a good one: it checks the
  reconciliation, checks each `(account, instrument)` pair appears at most once,
  *and* asserts the fixture genuinely has >6 snapshots for the position, so it
  cannot go vacuous.
- **But that test now pins "investable wealth" ≡ total wealth.** The assertion
  at `:152-155` requires `investableWealthBase` to equal the consolidated total
  to within 5p — a total that includes an `bank_savings` account and all cash.
  §7.1 asks for *"% of investable wealth"*. That equality is now load-bearing
  and should be a recorded decision rather than a by-product of the fix.
- **`latestHoldings` keeps the *first* row on an `asof` tie** (`consolidate.ts:62`
  uses strict `>`). Deterministic given ledger order, and it is what accidentally
  masked M3's holding duplication from the consolidated total.
- **The S13 fix is sound and the suite is genuinely adversarial.**
  `applyMetadataConfirmation` (`accept.ts:161-177`) sets only the fields the
  operator supplied and always sets `metadata_confirmed`, ingest never asserts it
  for itself, and the confirmation is written to `acceptances[]` with the
  instrument id (`accept.ts:272-283`), pinned by
  `ingest-to-usconnect.test.ts:173-183`. The best test in the new suite is
  `:108-133`: confirm everything **except** `us_registered` and Pioneer falls
  back to `needs_classification` rather than being cleared for looking American.
  The review file's "confirm type & domicile" chip (`review-html.ts:41-52`)
  correctly triggers on `metadata_confirmed !== true`, so absent/`null`/`"true"`
  all ask.
- **§2 determinism holds, exactly as declared.** Repo-wide grep of `src/` for
  `Date.now|new Date|Math.random|randomUUID|randomBytes|process.env|toISOString`
  returns **one** hit: `main.ts:69`, the declared exception. `fetch` appears at
  `extract-llm.ts:41` (injected as `fetchFn`) and `commands.ts:172` (the CLI
  binding it) — nowhere else. `src/engine/` and `src/usconnect/` remain pure and
  import no I/O.
- **`--offline` genuinely prevents egress.** `main.ts:98`
  (`flags.offline === true || !apiKey`) makes offline both the default and the
  winner when an API key is also supplied; `cmdIngest` contains no network code
  and refuses live extraction outright (`commands.ts:107-109`); `review` and
  `report` have no network path at all. `test/cli.test.ts:208-216` checks
  `NETWORK_AUDIT.md` is untouched — worth strengthening to a `globalThis.fetch`
  stub that throws, which would prove no egress to *any* endpoint rather than
  just no audit row.
- **§9 gitignoring and the pre-commit rail are in order.** `.gitignore` carries
  `data/` and `**/vault.local.json` from commit 0; `package.json`'s `prepare`
  script wires `core.hooksPath`; `scripts/precommit-scan.mjs` scans staged files
  for NI/SSN/sort-code/institution-account patterns *and* for every string held
  in any local vault, with the six synthetic account numbers allowlisted by
  value rather than by path. Nothing writes client data outside `data/` — the
  only out-of-tree write is `NETWORK_AUDIT.md`, which carries timestamp,
  endpoint, purpose and redaction flag only (S7 above is about *where* it lands,
  not what it contains).
- **`documents/` is content-addressed and mode 600** (`store.ts:109-118`);
  re-ingesting identical bytes cannot duplicate the file. Good.
- **`test/cli.test.ts` is not vacuous.** It genuinely proves: the §3 directory
  layout and the 600-mode vault (`:58-73`); that nothing enters the ledger before
  acceptance (`:91-95`); that an unparseable document parks in
  `parse-runs/failed/` (`:98-109`); that a rejected line never reaches the ledger
  and the acceptance log records the operator and the injected timestamp
  (`:111-139`); and that the full 15-document run produces a schema-valid ledger
  with 15 documents, 15 acceptances, the exact engine-golden totals
  (442,559.54 / 566,476.21), the correct two-instrument PFIC list, and an
  appendix where every document has both `parsed_at` and `accepted_at`
  (`:141-184`). The UK-only null case (`:186-206`) is a real §7 check. What it
  does **not** assert is any cost figure beyond a currency code (`:176`), the
  compounding drag, id uniqueness, or anything through a PDF — which is how M1,
  M2 and M4 all survive a green suite.
- **The "binary is wired" test** (`:218-227`) only runs `households list`
  against an empty data root. The full pipeline through `main.ts` is exercised
  by hand (PROGRESS step 4.6) but not by the suite.
- **The counter-based id scheme is the right design.** I specifically tried to
  make it reuse an id after a discarded allocation and could not: the
  `while (seen.has(candidate))` guard covers the case where a factory's counter
  under-shoots because earlier ids were allocated and never persisted. The
  scheme's only weakness is the seeding gap in M2 — fix the seeding and it is
  sound.
- **Truncating the clock to whole seconds** (`main.ts:69`) also costs audit
  precision: `parsed_at` and `accepted_at` on `documents[]` and
  `acceptances[].accepted_at` are all second-resolution, so the ordering of two
  acceptances inside one second is unrecoverable.
- **`main.ts`'s arg parser** treats any flag value beginning with `--` as
  boolean `true` (`:27`), so `--asof --household X` silently yields
  `asof: true`, which then fails deep inside the engine rather than at the
  boundary. Minor, but the CLI is the operator's interface.
- **`execFileSync("pdftotext", [...])`** passes the path as an argv element with
  no shell, so there is no injection surface there.
- **§10 file-size discipline holds.** Largest Phase 4 file is
  `src/cli/commands.ts` at 323 lines; all of `src/cli/` totals 878. Nothing
  approaches 500.
- **`latestHoldings` returns `any[]`** (`consolidate.ts:56`), which is the one
  remaining hole in the PHASE_REVIEW_3 S9 typing work — and it is the function
  both Module 2 and Module 3 now depend on.

---

**Verdict:** Phase 4 delivers a working, genuinely local-first operator CLI, and
the two bugs the main loop found on its own are both real finds, correctly
fixed, and properly regression-tested — the Module 3 snapshot fix reconciles to
the penny against the consolidation on a live multi-snapshot ledger, and the S13
metadata-confirmation work is the strongest new code in the commit. Determinism,
`--offline`, `data/` gitignoring and the pre-commit rail all hold up under
direct examination. The gate is nonetheless not met. The "pdf" leg of §10's
Phase 4 row has never executed — there is no PDF in the repo, no test reaches
`readDocument`'s PDF branch, `pdftotext` is not installed, and the branch hashes
the converted text rather than the file and stores text under a `.pdf`
extension. The run-id fix is incomplete in both directions: under
`test/cli.test.ts`'s own clock all fifteen run ids are simultaneously in use as
ledger ids and one document's id equals its own `parse_run_ids[0]`, while two
unparseable documents ingested in the same second overwrite each other in
`parse-runs/failed/` — silent data loss on the path §5.3 exists to prevent.
`meridian review` re-run on an accepted run double-applies it, moving the cost
stack from £4,133/226.92 bps to £5,291/290.50 bps with no error. And the §6.3
output — the screen the SPEC calls the yTree-killer — sums four years of fees
into an "annual" 226.92 bps against a true 141.22, applies that rate to a
portfolio 2.4× the base it was measured on for a twenty-year projection, and
reports every category as "platform" because the ledger schema has nowhere to
put the category the parser already extracted correctly. Finally the results
JSON contains no §6.2 performance or benchmark section at all, while PROGRESS.md
step 4.6 states that `report` "runs the whole engine". **7 MUST-FIX, 20
SHOULD-FIX (10 new, 10 carried forward from PHASE_REVIEW_3 and verified still
open), 16 NOTE — Phase 5 must not open until M1–M7 are resolved and `npm test`
is re-run green.**
