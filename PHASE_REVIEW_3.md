# PHASE REVIEW 3 — Analytics engine (SPEC §6) + US-connected intelligence (SPEC §7)

**Reviewer:** Opus structural-reviewer subagent (SPEC §12.1).
**Scope reviewed:** commits `3781811` (Module 2) and `1bce35c` (Module 3), plus
the uncommitted working tree, against SPEC §2, §3, §6, §7, §10.
**Verification run:** `npm test` 108/108 green; `npx tsc --noEmit` clean;
`npm run lint` clean. Beyond re-running the suite I independently recomputed the
§6 closed-form cases, drove `consolidate`, `assessPfic` and `buildSitus` against
both Phase-3 fixture ledgers *and* the golden ingested ledger with the real
engine FX converter, regenerated both fixture households from
`scripts/gen-engine-fixtures.mjs` into a temp dir and byte-compared them, and
ajv-validated them against `schema/ledger.schema.json`.

**Working-tree caveat:** the tree is dirty relative to `1bce35c` — seven
modified files plus a new `src/usconnect/param-read.ts`. `git diff` confirms the
changes are prettier reflow, two added comments, and a split of `params.ts`
(496 → 386 lines) into `params.ts` + `param-read.ts`. **No behavioural change.**
The findings below hold for both the commit and the working tree.

**Headline:** the §7 acceptance criteria are met, and met honestly — I
reproduced every claimed number independently. Two of the four §6 acceptance
criteria (TWR/XIRR divergence, Dietz vs known TWR) are proved by genuinely
implementation-independent closed forms and are the best tests in the repo. The
third (dual-currency consolidation with an awkward FX date-mismatch) is **not
actually exercised**, and the dual-currency column it is supposed to prove
breaks by a penny on both fixture ledgers. The fourth (cost stack to the penny)
reconciles, but against hand-typed test constants rather than ingested figures.
Separately, two named §6.2 deliverables — daily-linked TWR construction and
benchmark/real returns — are not built.

---

## MUST-FIX

### M1. The §6 "awkward FX date-mismatch" acceptance criterion is not exercised through consolidation

§6 acceptance criterion (c) is *"dual-currency consolidation with a deliberately
awkward FX date-mismatch fixture."* The awkwardness exists only in
`test/engine-fx.test.ts:11-16`, an inline `RATES` array driven straight into
`convert()` in isolation. The consolidation suite never sees it:

- `test/fixtures/ledger/household-usuk-acceptance.json` has exactly **one** FX
  observation, `2026-06-30 GBPUSD 1.28`, and **every** holding carries
  `asof: "2026-06-30"`. `household-uk-only.json` is the same shape with no
  secondary currency at all.
- `test/engine-consolidate.test.ts:12-23` loads only those two ledgers.

So the criterion is satisfied at the unit level and not at the level it is
written at. Two consequences are directly observable:

- `consolidate.ts:105` (`warnings.push(...converted.warnings)`) never fires in
  any test — no consolidation test produces a staleness warning.
- `consolidate.ts:148-156`, the `try/catch` that keeps a missing secondary rate
  from sinking the whole consolidation and pushes
  `"secondary-currency figure unavailable for ..."`, is dead code in the suite.

The material is already available: `test/golden/ingested-ledger.json` carries
three GBPUSD observations (1.27 @ 2025-12-31, 1.29 @ 2026-03-31, 1.28 @
2026-06-30) and account A3 whose latest snapshot is `2026-04-05` — a genuine
date mismatch — and no test consolidates it. Required: a consolidation fixture
(or that ledger) where at least one holding's `asof` has no same-date rate, one
is stale enough to warn, one requires triangulation, and one has no rate at all,
with the expected totals and the expected `warnings[]` asserted.

### M2. The dual-currency secondary column does not reconcile to the headline (§6.1, §8)

`consolidate.ts:145-157` computes each slice's secondary figure by rounding the
base to 2dp, converting *that* rounded figure, and rounding again. Slices are
therefore double-rounded independently of the total. Measured, on the committed
fixtures:

| ledger | headline USD | `byInstrument` USD sum | `byAccount` USD sum |
|---|---|---|---|
| `household-usuk-acceptance.json` | 317,854.68 | **317,854.69** | **317,854.67** |
| `test/golden/ingested-ledger.json` | 566,476.20 | **566,476.21** | 566,476.20 |

One penny over and one penny under the headline, in the same result object, in
the feature SPEC §8 calls *"the signature of the product"* (§8: *"every headline
value rendered as a stacked GBP/USD pair"*). A report rendering the instrument
table in USD will not add up to the USD headline above it.

The existing guard cannot see this. `test/engine-consolidate.test.ts:42-59`
("every slice sums back to the total — no wealth created or lost") sums
`s.value.base.amount` only — it never touches `.secondary` — and uses a
`< 0.05` tolerance that would mask a 1p break even if it did. §6.1 requires
everything *"renderable in base AND secondary currency simultaneously"*; a
column that does not add up is not renderable.

Required: derive the secondary column so it reconciles (convert once from the
unrounded base and allocate the residual, or convert the unrounded slice value
and reconcile the largest slice), and extend the sum-to-total test to the
secondary column with an exact-penny assertion.

### M3. `timeWeightedReturn` accepts a flow it silently ignores, and §6.2's "daily linking" is not implemented

`performance.ts:42-50` declares
`periods: { start: Valuation; end: Valuation; flowAtEnd?: number }[]` and then
computes `factor *= p.end.value / p.start.value` — **`flowAtEnd` is never
read**. The parameter is in the public type, it is passed in every call in
`test/engine-performance.test.ts:31-34, 84-87`, and it does nothing; the tests
pass only because they *also* hand-roll the post-flow opening value into the
next period's `start.value` (1000 = 200 + 800 at `:33`).

A caller who reads the signature and supplies the flow the obvious way gets a
wrong number, silently. I ran it:

```
periods: [ {100 → 200, flowAtEnd: 800}, {200 → 500} ]   // caller left start pre-flow
timeWeightedReturn(...).return === 4          // i.e. +400%; the correct answer is 0
```

That is a 400-percentage-point error in the flagship §6.2 function, produced by
using the documented API as documented. Either honour `flowAtEnd` (carry it into
the next sub-period's opening value, and validate that consecutive periods
chain) or delete it from the type so the caller cannot be misled.

Second half of the same finding: §6.2 requires *"true time-weighted return (TWR)
with **daily linking**"*, and `performance.ts:1-5` claims it. There is no daily
linking. `timeWeightedReturn` geometrically links whatever sub-periods the
caller hands it; nothing in `src/engine/` turns a valuation series plus a dated
flow series into daily sub-periods, and no test supplies daily periods. The
sub-period construction is where TWR is actually won or lost, and it is the part
that does not exist.

### M4. §6.2 benchmarks and real returns are not built (and not recorded as deferred)

§6.2: *"Benchmarks: user-assigned composite per account (e.g., 60/40 in GBP
terms) from bundled index series (`params/shared/benchmarks/`, monthly,
extendable). Report both nominal and real (CPI series in params)."*

A repo-wide grep for `benchmark|cpi_uk|cpi_us|global_equity|global_bonds|
gbp_cash|us_equity` across `src/` and `test/` returns **four hits, all in
`test/params.test.ts`** (the Phase-1 shape checks on the series files). No
engine code reads `params/shared/benchmarks/`. There is no composite builder, no
per-account benchmark assignment, and no wiring of the CPI series;
`realReturn` (`performance.ts:163-166`) takes two bare index numbers from the
caller and is exercised only with hand-written literals
(`test/engine-performance.test.ts:131`).

This is a named Module 2 deliverable and §8 report section 3 (*"Performance vs
benchmark, labelled by method"*) depends on it. Acceptable resolutions: build
it, or record an explicit deferral to Phase 5 as a dated entry task in
PROGRESS.md — exactly the precedent set for PHASE_REVIEW_2 S8. What is not
acceptable is Phase 3 closing with §6.2 silently half-delivered.

---

## SHOULD-FIX

### S1. Unrounded floats leak into the `usconnect` result object

Confirmed, driving `analyseUsConnect` with the real engine converter
(`toCurrency`). `JSON.stringify` of the result contains:

```
248323.96999999997   pfic.summary.investableWealthBase
60709.549999999996   situs.persons[0].usSitus.totalBase
176914.41999999998   situs.persons[0].nonUsSitus.totalBase
45553.549999999996   wrapperConflicts[401k].valueBase
```

Nothing in `src/usconnect/` rounds anything: `pfic.ts:78` (`sum`),
`situs.ts:24-26` (`column`), `wrapper.ts:18-21`, `currency.ts:44-50` are all raw
`reduce` over floats.

Assessing the actual risk honestly:

- **A wrong *displayed* figure is unlikely** from these particular values — any
  sane formatter renders 248323.96999999997 as £248,323.97. The values are all
  within 5e-11 of the correct penny.
- **But two concrete consequences are real.** (i) §8's narrative gate —
  *"every numeral in narrative must appear in results JSON, else reject"* —
  compares narrative text against the results JSON. A narrative correctly
  quoting "£248,323.97" will not match `248323.96999999997` and would be
  rejected; a validator loose enough to accept it is loose enough to accept a
  hallucinated figure. (ii) `investableWealthBase` = 248,323.96999999997 while
  `consolidate()` reports the same household's total as 248,323.97 — the report
  will carry two values for one concept from two modules that never agree by
  construction.
- One boundary is genuinely value-bearing: `pfic.ts:102`
  `belowThreshold = totalValueBase < thresholdBase` compares an unrounded sum to
  an unrounded converted USD threshold. A holding exactly on the s1298(f)
  de minimis line resolves on float noise.

Round monetary outputs at the module boundary using the shared `roundHalfEven`,
and pin it with a test asserting no result field carries more than 2 decimals.

### S2. `Math.round` is used where the FX policy mandates half-even

`params/shared/fx-policy.json:34` sets `"method": "half_even"`, and `fx.ts:52-64`
implements it correctly. But four call sites in the same module use JavaScript's
half-up `Math.round` instead:

- `consolidate.ts:146` — every base figure in every slice and the headline total
- `risk.ts:70` — geographic split
- `risk.ts:91-92` — wrapped / unwrapped per jurisdiction

Demonstrated divergence at 2dp: `2.345` → `2.35` (Math.round) vs `2.34`
(half-even); `0.125` → `0.13` vs `0.12`; `1234.565` → `1234.57` vs `1234.56`;
`-2.355` → `-2.35` vs `-2.36`. One penny, on the headline wealth figure, against
the documented policy. Use `roundHalfEven` throughout.

### S3. `convert()` rounds inside the engine, contradicting the policy it implements

`params/shared/fx-policy.json:35` states the rounding is *"banker's rounding on
presentation only; **engine keeps full precision internally**"*. `fx.ts:123` and
`:146` round every conversion to `amount_decimal_places` at the point of
conversion, and `consolidate.ts:98-107` then sums those already-rounded values.
The engine does the opposite of what the param says.

On the parent's specific question — per-holding-then-sum vs sum-then-convert:
the drift is real but small. On the acceptance fixture it is 7.3e-12 (1/1.28 is
exact in binary, so rounding barely bites). At a non-dyadic rate (1.2734) over
60 holdings the worst case I measured across 300 synthetic portfolios was
**£0.02**. So this is not by itself a headline error — but it is the same
double-rounding that produces M2's penny break, and fixing S3 (convert at full
precision, round once for presentation) fixes M2 as a side effect. Do them
together.

### S4. `fx.ts` hardcodes the USD pivot and ignores two policy values it reads

`fx.ts:132` `const pivot = "USD";` while
`fx-policy.json:28-31` carries `cross_rate_rule:
"triangulate_via_usd_when_direct_pair_absent"` — the value is typed at
`fx.ts:41`, destructured into `policy`, and never used. Likewise
`rate_decimal_places: 6` (`fx-policy.json:34`, typed at `fx.ts:42`) is never
applied: inverted rates (`fx.ts:84`, `1 / candidate.rate`) and triangulated
rates (`fx.ts:144`) are returned at full float precision. §2.3's "no constant in
engine code" is about rates and thresholds, so this is not a violation of the
letter — but a params key that exists, is read, and is then contradicted by a
literal is worse than not having it.

### S5. The two Phase-3 fixture ledgers are outside both the schema gate and the determinism gate

Both §6 and §7 acceptance rest entirely on
`test/fixtures/ledger/household-usuk-acceptance.json` and `household-uk-only.json`.
Neither is covered by:

- `test/schema.test.ts:24` — validates `household-usuk.json` only;
- `test/fixtures.test.ts:109` — the regenerate-into-tempdir-and-byte-compare
  list is `[statements, expected, "test/fixtures/ledger/household-usuk.json"]`.

PROGRESS.md step 3.0 asserts both are "schema-valid and deterministically
generated". I checked by hand: both **are** valid against
`schema/ledger.schema.json`, and both regenerate byte-identically from
`scripts/gen-engine-fixtures.mjs`. The claim is true; nothing in the suite keeps
it true. Add both to the two existing tests — it is a one-line change each, and
it is exactly the gap PHASE_REVIEW_1 raised for the Phase-1 fixtures.

### S6. The cost-stack reconciliation runs against hand-typed constants, not ingested figures (§6.3)

`test/fixtures/statements/sterling-park-wealth/mifid-costs-2025.txt` discloses
two control figures:

```
  TOTAL COSTS AND CHARGES                      £1,158.00
  Average portfolio value over period: £82,000.00
```

Neither survives ingestion. `schema/parse-output.schema.json` has no field for a
disclosed cost total or an average portfolio value, and
`test/fixtures/expected/sterling-park-wealth/mifid-costs-2025.json` carries only
the four fee lines. The acceptance test therefore hardcodes them
(`test/engine-cost.test.ts:12-13`: `DISCLOSED_TOTAL = 1158.0`,
`AVERAGE_VALUE = 82000.0`).

This is not worthless — `:15-20` does assert the fixture's four lines still sum
to 1,158.00, so a dropped line fails the build. But §6.3's standard is *"every
number traceable to a document"*, and the denominator of the headline bps figure
(141.22 bps) has no document source at all: it is a number a human typed into a
test. Add `disclosed_total` and `average_value` to the MiFID parse output, carry
them into the ledger, and reconcile the engine's computed total against the
*parsed* disclosure. That turns the acceptance criterion into what it says.

### S7. Only two of the five engine entry points take a ledger (§6)

§6 opens: *"Pure functions: `(ledger, params, options) → results`."*
`consolidate` and `assessRisk` honour that. `costStack`, `timeWeightedReturn`,
`modifiedDietz` and `xirr` take bespoke input shapes with no adapter from the
ledger — nothing maps `ledger.documents` / ingested fee lines into
`CostStackInput`, and nothing maps holdings + transactions into
`Valuation[]`/`Flow[]`. Phase 4's gate is *"pdf → accepted ledger → results JSON
on fixture"*, which cannot be met until those adapters exist; better to name
them now as Phase 4 entry tasks than to discover them at the gate.

### S8. `latestHoldings` has no disposal semantics and no staleness signal (§6.1, §8)

`consolidate.ts:56-65` keeps the newest snapshot per `(account, instrument)` at
or before `asof`. Two consequences:

- A position that is sold and therefore absent from all later statements is
  carried at its last observed value **forever**. I checked the golden ingested
  ledger for this: no instrument actually drops out between statement dates, so
  the hazard is latent, not manifest — but nothing prevents it and nothing
  detects it.
- No staleness is surfaced. Account A3 in the golden ledger has a latest
  snapshot of `2026-04-05`; consolidating at `2026-06-30` includes it silently,
  with no per-account data-freshness output. §8 report section 1 requires
  *"asof date and data-freshness per account"*, and the engine produces nothing
  the report could render for that.

### S9. The two currency columns are two different measurements, and it is not stated

`consolidate.ts:104` converts each holding at **`holding.asof`** — the holding's
own snapshot date. `consolidate.ts:149` converts the rounded base total to the
secondary currency at the **report `asof`**. So in a ledger with snapshots on
different dates, the base column is a sum of values converted at several
historical rates while the secondary column is that sum re-converted at one
current rate; the USD column is not the sum of the USD-at-snapshot values.
`consolidate` already states its look-through and joint-ownership assumptions in
`warnings[]` (`:136-143`) — this one belongs there too, and the choice deserves
a deliberate decision rather than an emergent one.

### S10. §6.4 concentration is per-instrument and measured against total, not investable, wealth

`risk.ts:47-54` flags `consolidation.byInstrument` entries whose
`shareOfTotal > threshold`. Two mismatches with what is written down:

- §6.4 asks for *"single-**issuer** >5% flags"*. Two share classes of one fund,
  or an issuer's equity plus its bond, are separate `byInstrument` rows and each
  can sit at 4.9% while the issuer is at 9.8%. There is no issuer key in the
  ledger, so this needs either an issuer field or an explicit recorded scope
  limitation.
- `asset-classes.json` sources the threshold as *"single-issuer positions above
  5% of **investable wealth**"*, but `shareOfTotal` is computed against total
  wealth including cash (`consolidate.ts:165`). The params text and the code
  disagree about the denominator.

### S11. The params sourcing gate does not reach the new Phase-3 params files

`test/params.test.ts:67` walks exactly three files for the
`{value, source, status}` discipline: `uk/2026-27.json`, `us/2026.json`,
`shared/fx-policy.json`. The two files added this phase are outside it:

- `params/shared/pfic-rules.json` — the entire §7 rule set. Its `cascade.rules[]`,
  `situs.rules[]` and `wrapper_mitigation.rules[]` are not `{value, source,
  status}` entries at all; they carry `sources[]` arrays instead. `readCascade`
  (`params.ts:106`) does enforce non-empty `sources` at runtime, so a sourceless
  rule would throw — but the params suite, which is where that discipline is
  supposed to be gated, is blind to the file.
- `params/shared/asset-classes.json` — `asset_class_by_type`,
  `liquidity_tier_by_type` and `wrapped_by_wrapper` carry no source at all.
  (Defensible: they are classification maps, not rates. Record the exemption
  rather than leaving it implicit.)

### S12. PHASE_REVIEW_2 S4, S5 and S9 were scheduled as Phase 3 entry tasks and are **not done**

Verified individually. PROGRESS.md is honest about it — all three are `[ ]`
under "Phase 3 entry tasks" and only S7 was ticked (as step 3.0) — but they are
now slipping a second phase.

- **S4 (exercise the <0.9 review branch)** — **not done.** `review-html.ts:38`
  (`class="line low"`) and `:45` (the page-image substitute note) are still
  unreachable in the suite: the only `renderReviewHtml` call is
  `test/ingest-pipeline.test.ts:140`, driven by `parseFixtureStatement`, whose
  confidences are fixed at 0.97/0.98 (confirmed: the only confidence values in
  all 15 expected fixtures are 0.97 and 0.98). The 0.72 and 0.55 confidences
  added at `test/ingest-pipeline.test.ts:235, 269` sit in *accept-flow* tests and
  never reach the renderer.
- **S5 (confidence on cash balances and FX observations)** — **not done.**
  `schema/parse-output.schema.json:92` is still
  `"cash_balance": { "$ref": "#/$defs/money" }`, and the `source.fx_rates` items
  (`:31-43`) still require only `pair` and `rate` with no confidence property.
- **S9 (replace `any[]` in `Ledger`)** — **not done, and worse.**
  `src/ingest/types.ts:131-137` is now **seven** `any[]` collections, not six —
  M1's new `acceptances` (`:136`) was added as `any[]` too. `npx tsc --noEmit`
  passes vacuously over `accept.ts`, `consolidate.ts` and `ledger-view.ts`,
  which is precisely where §4's canonical model matters.

### S13. Nothing in the pipeline can ever set `metadata_confirmed`, so the real ingest path yields zero PFIC flags

The S7 gate works (see NOTE below) — but it works by refusing everything the
pipeline can produce. Grep for `metadata_confirmed` across `src/` finds it only
in `usconnect` (reading it) and in `scripts/gen-engine-fixtures.mjs` (writing
it into hand-authored fixtures). `src/ingest/accept.ts` never writes the field,
and `test/golden/ingested-ledger.json` confirms it: **not one of the ten
ingested instruments carries `metadata_confirmed`.** Running §7 over the golden
ingested ledger therefore routes 100% of holdings to `needs_classification` and
flags zero PFICs. `us_registered` and `hmrc_reporting_fund` are still never
populated either — the original half of PHASE_REVIEW_2 S7.

That is the correct conservative behaviour, and it is the right place to be at
the end of Phase 3. But it means the §7 acceptance criterion is demonstrated
only on a ledger the system cannot itself produce. Phase 4's `meridian review`
needs an operator instrument-confirmation step (type, domicile, `us_registered`,
`hmrc_reporting_fund` → `metadata_confirmed: true`, logged in `acceptances[]`).
Record it as a Phase 4 entry task now.

---

## NOTE

- **§7 acceptance criteria verified independently**, not merely re-run. Working
  from the fixture by hand: the five PFIC positions are Sterling Park OEIC in A1
  (£27,762.50) and A2 (£17,768.00), Northgate OEIC in A1 (£13,660.00), and Atlas
  UCITS ETF in A1 (£29,259.00) and A3 (£73,485.00) — total £161,934.50, which is
  what `summary.totalValueBase` reports. Four are CRITICAL; the A3 Atlas is WARN
  under the SIPP mitigation rule, exactly as §7.1's edge-case paragraph
  directs, with `outcome` still `pfic`. Thames Utilities and Amalgamated Tech
  are `not_pfic` via `direct_security_or_cash`; Pioneer and Keystone via
  `us_registered_fund`; Harbour Point via `metadata_unconfirmed`. ISA = WARN and
  SIPP = OK come straight from `wrapper-matrix.json` with the explanation text
  asserted equal to the params string. Situs puts the whole 401(k)
  (£45,553.55) **and** the US-incorporated share held in the UK GIA (£15,156.00)
  on the US side — £60,709.55 — with £176,914.42 non-US and the unconfirmed
  £10,700 in a third column rather than either. The UK-only household returns
  `null`, not an empty object. **All of it checks out.**
- **PHASE_REVIEW_2 S7 is genuinely enforced and I could not find a bypass.**
  `ledger-view.ts:125` uses `instrument["metadata_confirmed"] === true`, so
  absent/null/`"true"` all read as unconfirmed. `param-read.ts:97-102` matches
  boolean keys against `expected === true`, so the `when: {metadata_confirmed:
  false}` clause bites on anything not explicitly `true`. `metadata_unconfirmed`
  is the **first** rule in the cascade, and `firstMatchingRule` throws if
  nothing matches, so the cascade cannot fall through to a permissive default.
  The ordering is pinned by `test/usconnect.test.ts:150-158`, which deletes the
  field from every instrument and asserts *all fourteen* positions — including
  the two `us_registered: true` funds that would otherwise short-circuit to
  `not_pfic` — route to `metadata_unconfirmed`. That test fails if anyone
  reorders the params cascade. This is the right shape.
- **§2 determinism holds.** Repo-wide grep of `src/` for
  `new Date(|Date.now(|Math.random(|process.env` returns **zero** hits.
  `daysBetween` (`performance.ts:29-34`) parses supplied ISO strings with an
  explicit `Z`, which is a parse, not a clock read. `test/usconnect.test.ts:394`
  pins this for `src/usconnect/` with a source-text assertion. AI remains
  strictly at the edge: nothing in `src/engine/` or `src/usconnect/` imports
  `extract-llm.ts` or performs I/O.
- **§10 file sizes conform.** Largest source files: `src/usconnect/params.ts`
  386 (496 at `1bce35c`, split in the working tree), `types.ts` 194,
  `consolidate.ts` 182. All under 500.
- **The two closed-form §6.2 cases are the best tests in the repo.** Case A's
  XIRR expectation is derived algebraically in the test comment
  (`5x² − 8x − 1 = 0` ⇒ `r = 10/(8+√84) − 1`) and asserted to 1e-9, with a
  guard test at `:137-141` pinning the inputs so the case cannot be weakened.
  Case B's Dietz weight is exactly 0.5 by construction (day 182 of 364) giving
  260/1250 = 0.208 exactly, against a true TWR of 1.1 × 1.1 − 1 = 0.21. The
  `compoundingDrag` expectations (`test/engine-cost.test.ts:79-81`) are likewise
  independent closed forms. None of these was recorded from the implementation.
- **XIRR edge behaviours worth knowing.** Same-day flows (`[-1000, +1200]` both
  on 2025-01-01) throw *"no sign change in the search bracket"* rather than a
  useful message. A non-unique IRR (`-1000, +2600, -1680`, which has roots near
  20% and 40%) returns 0.2037 with no signal that the answer is not unique. The
  convergence test `Math.abs(value) < tolerance` is an **absolute** NPV
  threshold in currency units, so on a £5m portfolio the returned rate came from
  the step-size branch with a residual NPV of 5.6e-9 rather than 1e-12 — correct
  to ~9sf, but scale-dependent. Sign handling itself is right: both-signs is
  required up front, the base date is the minimum (so unsorted flows work — I
  checked), and the bisection fallback is a correct implementation.
- **`roundHalfEven` is correct**, including for negatives (`-0.125 → -0.12`,
  `-0.135 → -0.14`), and the `toPrecision(15)` pre-scale is the right fix for
  the `0.145 * 100 = 14.499999999999998` problem. It degrades above ~£10tn
  (2dp scaling exceeds 15 significant digits); irrelevant at any realistic
  household scale and not worth changing.
- **The 401(k)/IRA wrapper-mitigation rule cites the wrong authority.**
  `pfic-rules.json:64-71` applies one mitigation rule to
  `["sipp", "ira_trad", "ira_roth", "401k"]` and sources it to *"UK/US DTA 2001
  Arts. 17-18"*. For a **US person's own** 401(k) or IRA the treaty is not the
  operative basis — the usual basis is domestic (the plan's exempt status, cf.
  Treas. Reg. 1.1291-1(e) for exempt organisations). The **outcome** is right;
  the citation is not, and §12.1 requires every encoded rule to carry a correct
  source. Split the rule: UK pensions on the treaty article, US qualified plans
  on the domestic basis.
- **§7.2's ISA "annual US drag estimate" is not produced.** §7.2 asks for the
  ISA WARN *"with annual US drag estimate **if holdings data allows**"*.
  `buildWrapperConflicts` (`wrapper.ts:13-38`) emits `valueBase` only. The
  ledger holds no dividend or income data for the ISA, so the condition
  arguably is not met — but the conditional should be an explicit recorded
  decision rather than an omission.
- **Two smaller §7.3 observations.** (i) The situs class
  `us_bank_deposits_non_business` is assigned to *all* cash including GBP cash in
  a UK GIA; the outcome (non-US situs) and the `sources` text are both right,
  but the class name reads wrong on a UK deposit. (ii) The `us_retirement_plan`
  rule sits *ahead* of `metadata_unconfirmed` in the situs cascade
  (`pfic-rules.json:157-169`), so an unconfirmed instrument inside a 401(k) is
  still classified US-situs. That is correct by design — the estate asset is the
  plan interest, with no look-through — but the fixture has no unconfirmed
  holding in a US plan, so the deliberate ordering is untested.
- **`shareOfInvestableWealth`'s denominator** (`pfic.ts:80-82`) is the investable
  wealth of positions *held for a US person*, not household investable wealth.
  Identical for the single-person acceptance household; they diverge in a mixed
  household. The choice is explained in the code comment at `pfic.ts:66-70`, so
  this is a note, not a defect — but the report must label the percentage
  accordingly.
- **Cost-stack behaviour is honest where it claims to be.** `cost.ts:59-63`
  genuinely refuses an unattributed line and `test/engine-cost.test.ts:59-75`
  proves it. Per-account bps against per-account average value and category bps
  against the aggregate base are both the right denominators, and
  `test/engine-cost.test.ts:105-126` proves the same cash fee is twice the drag
  on half the money. `costStack` also refuses cross-currency aggregation
  (`:52-56`, `:64-68`) rather than converting silently — the right call.
- **`consolidate` states its assumptions.** The look-through proxy
  (`:136-140`) and equal joint-ownership split (`:141-143`) are both pushed to
  `warnings[]` and deduplicated, and the joint-split assumption is mirrored in
  `pfic-rules.json situs.attribution` and surfaced as a §7 `assumptions[]` entry
  — consistent across both modules.
- **PROGRESS.md is accurate.** Step 3.6 lists the §7 outcomes the main loop
  claims to have verified independently, and every one of them reproduces. The
  three unfinished PHASE_REVIEW_2 items are left unticked rather than quietly
  closed. That discipline is exactly what §12.5 asks for.
- **Test count.** The brief says 107; the suite reports **108** passing. The
  extra test is in the uncommitted working tree.

---

**Verdict:** Module 3 is the strongest work in the repo so far — the PFIC
cascade, situs cascade and wrapper matrix live entirely in params, the S7
metadata gate is genuinely un-bypassable and pinned by a test that would fail on
a params reordering, and every §7 acceptance number reproduces under independent
recomputation. Module 2's return mathematics is correct where it is implemented,
and its two closed-form acceptance cases are properly independent of the code.
What blocks the gate is on the consolidation and performance side: the
"awkward FX date-mismatch" criterion is proved only at the `convert()` unit and
never through `consolidate()`, whose warning and refusal paths are consequently
dead code; the dual-currency column that criterion exists to protect breaks by a
penny on both fixture ledgers and the only guard test never looks at it;
`timeWeightedReturn` accepts a `flowAtEnd` it silently discards, which returns
+400% instead of 0% when used as documented; and §6.2's benchmark composite and
real-return reporting are absent without a recorded deferral. The float-hygiene
question the brief raised is real but second-order — the unrounded `usconnect`
values will not by themselves produce a wrong printed figure, though they will
break §8's narrative-numeral validator and guarantee two disagreeing totals for
one concept; the per-holding-then-sum drift is bounded at about 2p over 60
holdings, and fixing the engine to keep full precision internally (as its own
params file already says it does) resolves both that and the penny break
together. **4 MUST-FIX, 13 SHOULD-FIX, 14 NOTE — Phase 4 must not open until
M1–M4 are resolved and `npm test` is re-run green.**
