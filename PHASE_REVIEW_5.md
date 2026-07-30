# PHASE REVIEW 5 — Mobile-first client report, PWA, deck, narrative (SPEC §8)

**Reviewer:** Opus structural-reviewer subagent (SPEC §12.1).
**Scope reviewed:** commit `4f64fe9` against SPEC §2, §3, §8 (in full), §9,
§10 Phase 5 row. Working tree clean (`git status --porcelain` empty), so this
reviews exactly the committed state.

**Verification run.** `npm test` 165/165 green; `npm run typecheck` clean;
`npm run lint` clean. Beyond re-running the suite I:

- rendered the report, the deck and the UK-only report from
  `test/fixtures/ledger/*` **and** from `test/golden/ingested-ledger.json` (the
  realistic one — the acceptance fixture has no fees and one valuation date);
- served them over `http://127.0.0.1` and drove them in a real Chrome, at
  desktop width and inside a 390×844 frame;
- measured every table's overflow, every focusable element, every heading,
  every table header, and the computed colour/size of every text token;
- computed WCAG contrast ratios for the actual palette hex values;
- attempted the exact service-worker registration the report performs, and
  resolved the manifest's `start_url` against its own URL, to test §8's
  "installable as a PWA when served";
- printed both reports to PDF with headless Chrome and inspected the page
  geometry and the colour operators in the resulting content streams;
- built a **US-person household with zero critical flags** (not the UK-only one
  the test uses) to check the "no red anywhere" criterion non-vacuously;
- drove `validateNarrative` with nine adversarial strings;
- re-ran the whole results→report pipeline at a non-default growth assumption
  to test whether the report ever computes its own numbers.

Every measured figure below came out of one of those runs. Nothing is inferred.

**On Lighthouse.** PROGRESS.md is honest. Lines 4 and 30–37 state plainly that
Lighthouse was **not run**, that neither binary is installed, and that the
criterion is UNVERIFIED — and it lists what was checked instead rather than
implying the threshold was met. I confirm: `which lighthouse` / `which lhci` →
not found; neither is in `node_modules`; and `.claude/settings.json`'s deny-list
forbids the network fetch an `npx` install would need. That record stands as
written. See NOTE N1 for what evidence would actually close it — and note that
three of the findings below (M6, S6, S7) are exactly the sort of thing a
Lighthouse accessibility run would have caught, which is an argument for
running it rather than for substituting hand checks.

**Headline.** The design is genuinely good and genuinely distinctive: the ink /
paper / brass palette is disciplined, red really is reserved (I verified this
holds for a US-person household with zero flags, not just for the UK-only
household where the section is absent entirely), the sections are ordered by
the client's questions, the appendix is a real trust product, there are no
gradients, no glassmorphism and no decorative numbering, the file is 27–37KB
against a 400KB budget with zero network requests, and the primacy swap on the
currency toggle is implemented properly and looks right. But four of §8's hard
requirements are not met as written. The dual-currency ledger column is *not*
the signature — it appears in four tables out of twelve and the toggle does not
touch it, so the button labelled "Show in USD" leaves almost the whole report in
GBP. Every table on the page forces horizontal scrolling at 390px, which on the
PFIC table puts the severity and value columns off-screen on the target device.
The PWA is neither installable nor service-worker-backed — the blob-URL
registration Chrome rejects outright, and I have the error. The report computes
its own compounding projection with a hard-coded 5% growth rate, which
contradicts the engine's own figure in the sentence directly beneath it. And the
new `--narrate` egress path ships the operator's document filenames to the API
while writing `redaction_check: "pass"` to NETWORK_AUDIT.md without ever
checking. Phase 5 should not be signed off yet.

---

## MUST-FIX

### M1. The report computes its own compounding projection, with a hard-coded 5% growth rate, and contradicts the engine

**SPEC §2.1:** *"All financial computation (returns, fees, tax flags, situs, FX)
is pure, deterministic, unit-tested TypeScript."* **§6.3** puts the 20-year drag
projection in the engine, *"at user growth assumption"*. **CLAUDE.md:** *"boring
code in the engine; spend cleverness only in the report design"*.

`src/report/render.ts:136-143` hands `dragChart` a growth rate it invents:

```ts
startingValue: compoundingDrag.grossTerminal.amount / Math.pow(1 + 0.05, compoundingDrag.years),
grossRate: 0.05,
netRate: 0.05 - costStack.total.bps / 10_000,
```

`src/engine/cost.ts:125-143` already did this calculation, from
`input.grossGrowthRate` — which `src/cli/results.ts:150` takes from
`input.growthAssumption` and only *defaults* to 0.05
(`DEFAULT_GROWTH_ASSUMPTION`, results.ts:20). The engine's rate is not exposed
on `CompoundingDragResult` (cost.ts:110-117 returns only terminals, drag, share,
years and a prose `assumption`), so the report guesses it.

`src/report/charts.ts:102-131` then re-implements the compounding *and prints
the results as figures* — `formatValue(grossAt(steps))` and
`formatValue(netAt(steps))` in the legend (charts.ts:129, 131).

Measured, on the acceptance fixture with one £3,200 platform fee injected so the
projection is non-degenerate:

| growthAssumption | engine `netTerminal` (the sentence at render.ts:144) | chart legend "After costs" (charts.ts:131) |
|---|---|---|
| 0.05 (default) | £514,693.38 | £514,693 |
| 0.08 | £910,405.76 | **£904,144** |

Two different "after costs" numbers, £6,262 apart, in the same paragraph of the
same report. It only agrees at the default because dividing by `1.05^20` and
multiplying by `1.05^20` cancels; the moment the operator sets a different
growth assumption the chart draws the wrong curve from a fabricated starting
value (£436,214 rather than the true £248,324) and the gap — which the chart's
own comment calls "the story" — is drawn at the wrong scale.

Fix direction: return `grossGrowthRate` (and the fee rate) on
`CompoundingDragResult`, and have `dragChart` take the two terminal values and
the series from the engine rather than re-deriving them.

### M2. Every table forces horizontal scrolling at 390px; on the PFIC table, severity and value are off-screen

**SPEC §8:** *"Designed at 390×844 first; single-column flow"*, *"all charts
render legibly at 390px with horizontal-scroll explicitly forbidden"*.
**SPEC §2.5:** *"Mobile-first is a build constraint, not a polish step."*

`src/report/styles.ts:130`: `table { … min-width: 30rem; … }` — 480px,
unconditional, for every table including the three-column ones.

Measured in Chrome, `golden.html` in a 390×844 frame (386px inner width). All
**12** `.scroll` regions overflow, identically:

```
Accounts / Charges / Benchmark comparison / Performance by account /
Position / Concentration flags / Currency / Wrapped versus unwrapped /
PFIC holdings / Wrapper treatment / Situs exposure / Source documents
  → scrollWidth 480, clientWidth 332   (every one)
```

The consequence on the section §8 singles out as the one that matters: on a
390px phone the "Passive foreign investment companies" table shows the holding
names and then clips mid-chip — the reader sees `CR…`, `IN…`, `WA…` and no
values at all, and must scroll sideways inside the box to find out which of
their holdings is CRITICAL and what it is worth. That is the opposite of
designed-at-390-first; it is a desktop table put inside a scroller.

The `.scroll` container is the right *escape hatch* for a genuinely wide table
(and the `role="region"` + `aria-label` + `tabindex="0"` pattern is exactly
right — see N10). It is not a substitute for a mobile layout. The three-column
tables in particular fit in 332px comfortably; the 480px floor is what stops
them.

Note this interacts with S12: `body { overflow-x: hidden }` means none of this
shows up as page overflow, so the test at `test/report.test.ts:52-60` passes.

### M3. The dual-currency ledger column is not the signature, and the currency toggle barely does anything

**SPEC §8 design direction:** *"the product's identity is two currencies, one
truth. Signature element: the dual-currency ledger column — **every** headline
value rendered as a stacked GBP/USD pair … the currency toggle animates a swap
of primacy rather than hiding one."* **§6.1:** *"Everything renderable in base
AND secondary currency simultaneously (dual-column is the signature of the
product)."*

The primacy swap itself is implemented correctly — `styles.ts:99-107` and
`render.ts:421-432`, verified in the browser: the two figures exchange size,
colour and side, neither is hidden, and it respects `prefers-reduced-motion`.
(Be careful measuring this: in a backgrounded tab Chrome freezes the transition
and `getComputedStyle` returns the pre-toggle value indefinitely. It works.)

What it swaps is one number. Measured across the golden report:

- **`.rowpair` has no `[data-primary]` rule at all** (`styles.ts:109-110` — the
  only two `.rowpair` rules, neither state-dependent). The account table, the
  top-ten positions and the currency table render the pair, but the base
  currency is permanently large-and-first and the secondary permanently
  small-and-second. Confirmed in the browser: `£113,647.20 $145,468.42` in both
  toggle states, same order, same sizes.
- Everything else is **base currency only**, with no secondary at all:
  the cost total and every cost line (`render.ts:131, 123`), the concentration
  flags (`:202`), the wrapped-vs-unwrapped table (`:232-233`), every PFIC
  holding value (`:254`), and the whole situs table (`:270-272`).

So a client on `Show in USD` sees exactly one figure in USD — the total wealth
headline — while their charges, their PFIC exposure and their estate-exposure
sketch stay in GBP. The button's label is a promise the report does not keep,
and the element §8 calls the signature is present in 4 tables out of 12.

### M4. The PWA is neither installable nor service-worker-backed

**SPEC §8 deliverable:** *"one self-contained HTML file … that is: installable
as a PWA when served, fully functional offline once opened"*.

Measured in Chrome over `http://127.0.0.1:8137` (a valid secure context):

1. **The service worker never registers.** `src/report/render.ts:407-416`
   registers a `blob:` URL. Running that exact registration in the page:

   ```
   TypeError: Failed to register a ServiceWorker: The URL protocol of the
   script ('blob:http://127.0.0.1:8137/…') is not supported.
   ```

   `navigator.serviceWorker.getRegistrations()` → **0 registrations**. The
   `.catch(function () {})` at render.ts:414 swallows it, so nothing surfaces —
   which the comment at :407-408 intends for `file://` but which also hides a
   hard failure over http. A service-worker script must come from a same-origin
   http(s) URL; blob and data URLs are rejected by every engine.
2. **`start_url` is unresolvable.** `render.ts:378` / `:390` set
   `start_url: "."`. Manifest member URLs resolve against the manifest's own
   URL, which here is a `data:` URL (render.ts:380) upgraded to a `blob:` URL
   (render.ts:401). Resolving in the page:
   `new URL(".", manifestHref)` → `TypeError: Failed to construct 'URL':
   Invalid URL`.
3. **There are no icons.** The manifest object (render.ts:372-379, 384-391) has
   no `icons` member. Chrome's installability criteria require at least one
   icon of 144px or larger. Without it there is no install prompt regardless of
   the other two points.

Net: "installable as a PWA when served" is not true, and "fully functional
offline once opened" is true only in the trivial sense that a single self-
contained file with no subresources needs nothing to reopen — which would be
equally true with the entire `pwa()` block deleted.

`test/report.test.ts:90-99` asserts only that the strings `rel="manifest"`,
`serviceWorker`, `application/manifest+json` and `catch` appear in the output.
It cannot fail while the feature is broken.

Fix direction: either drop the PWA claim to what the file actually is (a
self-contained document that works offline because it has no dependencies), or
emit a real sibling `sw.js` + `manifest.webmanifest` + an inline-SVG data-URI
icon when the report is written to a directory, and keep the graceful `file://`
degradation.

### M5. `--narrate` sends the operator's document filenames to the API and records `redaction_check: "pass"` without checking

**SPEC §2.2:** *"The parsing pipeline redacts direct identifiers … before any
API call."* **§8:** *"sends the computed results JSON (numbers only, no client
identifiers)"*. **§9:** *"Anthropic API calls: redacted content only; log every
call in NETWORK_AUDIT.md"*.

`src/report/narrative.ts:130-148` posts `JSON.stringify(results)` — the whole
object. That object carries, from `src/cli/results.ts:236-244`:

- `appendix.documents[].filename` — set from `basename(options.file)` at
  `src/cli/commands.ts:128, 212`, i.e. **the operator's own file name for the
  client's statement**, verbatim, never redacted. The fixtures happen to be
  named `sterling-park-wealth/mifid-costs-2025.txt`, which is why this is
  invisible in test; a real upload named after the household is not.
- `appendix.documents[].institution`, and `usConnect.pfic.holdings[].instrumentName`.

And `narrative.ts:123-128` writes the audit row with the literal
`redaction_check: "pass"` **without calling `assertRedacted`** — the audit line
asserts a check that never happened. Compare `src/ingest/extract-llm.ts:65`,
which calls `assertRedacted(redactedText, deps.vault)` before it does anything
else; the Phase 2 gate has a dedicated failing-path test proving that gate
blocks an unredacted call (`§5` criterion b). Phase 5 added a second egress
path with none of that.

This is compounded by S10: `narrateSection` and `generateNarrative` have **zero
tests**. The only narrative test coverage is of `validateNarrative`.

Fix direction: run the results object through `assertRedacted` (or through a
whitelist projection that drops `filename`/`institution` entirely — the model
does not need them to write commentary) before the fetch, and derive
`redaction_check` from that call's outcome rather than hard-coding it.

### M6. The brass accent fails WCAG AA contrast wherever it carries text

**SPEC §8:** *"WCAG AA contrast"*, *"Lighthouse mobile ≥90 performance /
**≥95 accessibility**"*.

Computed from the committed hex values (WCAG 2.x relative luminance):

| foreground | on `--paper #FAFAF7` | on `--paper-sunk` | on `--alert-wash` |
|---|---|---|---|
| `--ink #101B2D` | 16.51 ✓ | 15.24 ✓ | 14.57 ✓ |
| `--ink-soft #4A5568` | 7.20 ✓ | 6.65 ✓ | 6.35 ✓ |
| `--alert #A3231B` | 7.14 ✓ | 6.59 ✓ | 6.30 ✓ |
| `--ok #2E6B4F` | 6.03 ✓ | 5.57 ✓ | 5.32 ✓ |
| **`--brass #8C7A3F`** | **4.04 ✗** | **3.73 ✗** | **3.57 ✗** |

4.5:1 is required. None of the brass text qualifies for the large-text
exception (≥24px, or ≥18.66px bold). Measured computed sizes in the browser:

- `.eyebrow` (styles.ts:71-74) — **10.88px**, weight 600, `color: var(--brass)`.
  This is the label on every one of the six section headings, and the "MERIDIAN"
  masthead.
- `.chip-warn` (styles.ts:170) — **11.52px** brass. Every WARN and INFO badge in
  the US-connected section, including on `.critical-row`'s wash background
  where it drops to 3.57:1.
- `.commentary .byline` (styles.ts:182-185) — brass, 0.68rem. The
  "AI-GENERATED COMMENTARY" attribution, which §8 requires the reader to be
  able to read.
- `button[aria-pressed="true"]` (styles.ts:118) — the currency toggle's label
  turns brass when engaged, at 0.85rem.

`:focus-visible { outline: 2px solid var(--brass) }` (styles.ts:119) is fine —
focus indicators need 3:1, and 4.04 clears it.

Fix direction: darken the brass for text use (a second token, e.g. a
text-weight brass around `#6E5F2C`, keeps the accent identity while clearing
4.5:1) and keep `#8C7A3F` for rules, bars and focus rings where 3:1 suffices.

### M7. `--deck` is the report with a class name, not a paged summary

**SPEC §8:** *"Also a `--deck` mode producing a **paged summary** for
screen-sharing."*

`src/report/render.ts` adds `class="slide"` to the header and each of the six
sections (`:92, 128, 178, 206, 276, 354, 459`); `src/report/styles.ts:222-229`
gives `.slide` `min-height: 100svh`, centring and `scroll-snap-align: start`.
Nothing else differs — same sections, same tables, same rows.

Measured, `golden-deck.html` in a 390×844 frame (698px inner height):

| slide | height | fits one page? |
|---|---|---|
| header | 698px | yes |
| wealth | 952px | no (1.4×) |
| cost | 1,200px | no (1.7×) |
| performance | 920px | no (1.3×) |
| exposure | 1,547px | no (2.2×) |
| us-connected | 2,046px | no (2.9×) |
| appendix | **2,685px** | no (**3.8×**) |

Total document height 10,550px across 7 "slides", carrying all **12** tables.
`scroll-snap-align: start` therefore snaps you to the top of a slide and then
lets you scroll through two more screens of it before the next snap point — the
paging is decorative. The appendix, a full document-provenance table, is a
"slide".

Separately, `render.ts:441-444` renders the currency toggle only when
`secondary && !deck`, so the artifact intended for screen-sharing is the one
artifact that **cannot show the second currency at all** — in a product whose
stated identity is "two currencies, one truth".

Fix direction: `--deck` should select content (headline, cost headline + drag,
return vs benchmark, top concentrations, critical-flag count and the PFIC
CRITICAL rows only), cap each slide to one screen, and keep the toggle.

---

## SHOULD-FIX

### S1. The currency toggle demotes the cost and performance headlines to nothing

`src/report/render.ts:131` and `:183` use the signature element for a
**single**-valued headline:

```html
<p class="pair"><span class="primary">£1,418.00</span></p>
<p class="pair"><span class="primary">1.3%</span></p>
```

`:root[data-primary="secondary"] .pair .primary` (styles.ts:99-102) then shrinks
them from 49.6px ink to 23.2px `--ink-soft` and pushes them to the baseline —
with nothing promoted in their place, because there is no `.secondary` sibling.
Confirmed by screenshot: with the toggle engaged, "Cost of ownership" leads with
a small grey £1,418.00 that looks like a footnote. Same for the return headline.

`pair()` at render.ts:30-33 has the same shape for a `DualMoney` with no
secondary. Use a separate class for single-value headlines, or scope the
override to `.pair:has(.secondary)`.

### S2. `validateNarrative` has large holes, and nothing enforces the no-advice rule

**SPEC §8:** *"Narrative never introduces a number not present in the computed
results (validate: every numeral in narrative must appear in results JSON, else
reject)."*

The validator (`src/report/narrative.ts:76-88`) does catch the obvious case —
I confirmed `£4,318,222.11` and `£248,323.98` are both rejected, and that
formatting variants of a real figure are accepted. Nine adversarial probes
against the real acceptance results object; **eight passed**:

| probe | verdict |
|---|---|
| "roughly **forty-two** basis points … about **a third** of the industry norm" | ACCEPTED |
| "Total wealth is **1.5 million** pounds" | ACCEPTED |
| "You paid **£1,950** … and will pay **£2,050** next year" | ACCEPTED |
| "Around **20%** … and **10%** more is uninvested" | ACCEPTED |
| "Charges are **100 times** the amount you would pay elsewhere" | ACCEPTED |
| "This is the **3rd** largest position" | ACCEPTED |
| "Your return was **0.5%** and inflation was **3%**" | ACCEPTED |
| "**You should sell the PFICs** before year end" | ACCEPTED |
| "Your portfolio will be worth **£4,318,222.11**" | rejected ✓ |

Specific mechanisms:

- **Spelled-out numbers and magnitude words are invisible.** The scanner is
  `/\d[\d,]*(?:\.\d+)?/g` (narrative.ts:79) — "forty-two", "a third", "half",
  "double" never match, and "1.5 **million**" passes because `1.5` collides
  with something in the allowed set while the multiplier is unchecked.
- **The year bypass is a money-shaped hole.** narrative.ts:84 admits any literal
  matching `^(19|20)\d{2}$` after comma-stripping. `£1,950` normalises to
  `1950`; `£2,050` to `2050`. Every monetary amount between 1,900 and 2,099 —
  and every such amount written with a comma — is exempt from validation. Fee
  figures live squarely in that range.
- **`ALLOWED_BARE`** (narrative.ts:73) unconditionally admits 0–10, 20 and 100,
  so "20% of the portfolio" and "10% more" are always allowed regardless of the
  results.
- **The allowed set is very large by construction.** `add()` (narrative.ts:32-45)
  emits eight normalised variants (×100 at 0/1/2dp, ×10,000 at 0/2dp, and
  0/1/2dp of the raw value) for *every* number anywhere in a results object that
  contains several hundred of them, plus every array length. Collision-by-luck
  is likely, not hypothetical — see the "0.5% / 3%" probe.
- **Nothing enforces §9's no-advice rule.** "You should sell the PFICs before
  year end" contains no numerals, so the validator is silent. The only defence
  is the system prompt (narrative.ts:95). §9 forbids personal recommendations
  and §1 puts them explicitly out of scope for v0; a deterministic
  imperative/recommendation screen belongs next to the numeral screen.

Note the validator is genuinely well-designed for what it was aimed at — the
issue is that "every numeral appears in the results" is a weaker invariant than
"the narrative asserts nothing the engine did not compute", and the gap between
the two is where an LLM lives.

### S3. The "no red anywhere" acceptance test is vacuous

`test/report.test.ts:127-139` asserts on `ukOnlyHtml`, and its own first line is
`assert.equal(ukOnlyResults.usConnect, null)`. With no US person the entire
section is absent (render.ts:242), `hasAlert` is false, and the alert tokens are
never emitted — the test cannot distinguish "red is correctly reserved" from
"there is no US section". §8's criterion is about a **PFIC-free** household, not
a US-free one.

I checked the real property directly: taking `household-uk-only`, making P1 a US
citizen and confirming every instrument as a direct US equity yields
`criticalCount: 0`, `wrapperConflicts` gia=WARN isa=WARN, all PFIC outcomes
`not_pfic/OK`. The rendered report contains no `#a3231b`, no `chip-critical`,
no `critical-row` and no `--alert` token. **The product behaviour is correct.**
It is the test that proves nothing. Add that household as a third fixture.

The mechanism that makes it correct is worth preserving deliberately:
`hasAlert = Boolean(usConnect?.criticalCount)` (render.ts:435) and
`criticalCount` (usconnect/index.ts:66-68) counts CRITICAL from **both** the
PFIC holdings and the wrapper conflicts — which are exactly the two places
`severityChip` can emit `chip-critical` (render.ts:245). If a third source of
CRITICAL is ever added, the class will be emitted with no rule behind it and a
CRITICAL badge will silently render as a neutral chip. A test asserting
"`chip-critical` appears iff `--alert` is defined" would pin it.

### S4. `Results.usConnect` is typed `unknown`, so the entire US section is `as any`

`src/cli/results.ts:43` declares `usConnect: unknown | null` (which collapses to
`unknown`) even though `analyseUsConnect` returns a fully-typed
`UsConnectResult | null` (`src/usconnect/index.ts:46`). The report pays for it:
`render.ts:241, 247, 251-254, 258-263, 266-273, 315-336, 435` are all `any`
casts and `any` callback parameters. A rename inside `UsConnectResult` — or a
severity value that stops being `"CRITICAL"` — produces a blank or wrong section
with no type error and no test failure. `usConnect.pfic?.filingImplication`
(render.ts:287) already has an `??` fallback suggesting uncertainty about the
shape. Import the type.

### S5. Raw severity enums are shown to the client

`render.ts:245` prints `esc(severity)` directly: the client sees `CRITICAL`,
`WARN`, `OK` and `INFO` badges. This is the same class of defect PROGRESS.md
records fixing for wrappers ("Wrapper enums were leaking into the client
report") — `src/report/format.ts:40-59` exists precisely for this. `INFO` is the
worst of them: on the golden ingested ledger every unconfirmed holding renders
an `INFO` chip next to a value, which tells the reader nothing at all (the real
meaning — "we have not classified this, so it is excluded rather than declared
safe" — is only in the appendix, `render.ts:363`).

Also `severityChip`'s ternary maps everything that is not `CRITICAL` or `OK` to
`chip-warn`, so `INFO` and `WARN` are visually identical.

### S6. Twelve data tables, zero `scope`, zero `<caption>`, zero row headers

Measured on the golden report: 12 `<table>`, 43 `<th>` in total, **0** with a
`scope` attribute, **0** `<caption>`, **0** `<th>` in any `<tbody>`. Every first
column — account name, charge name, holding name, wrapper, person — is a `<td>`.

For a report that is mostly tables this matters: a screen-reader user moving
through the PFIC table hears "CRITICAL" and "£27,762.50" with no way to
associate them back to "Sterling Park UK Equity Income OEIC Acc". `scope="col"`
on the header cells and `scope="row"` on the first cell of each row is a small
change; the `<caption>` can carry the `aria-label` that is currently on the
wrapping `.scroll` region. This is also one of the checks a Lighthouse
accessibility run flags, and §8 asks for ≥95.

### S7. Non-text contrast: category colours and the toggle border are below 3:1

WCAG 1.4.11 requires 3:1 for graphical objects that convey information and for
UI component boundaries. Against `--paper #FAFAF7`:

- `--rule-strong #B4B0A2` → **2.08:1**
- `--brass-soft #C4B587` → **1.95:1**

Both are members of `PALETTE` in `src/report/charts.ts:27`, used as the category
colours of the cost stacked bar and its legend swatches — so "transaction"
(#B4B0A2) and "fx spread" (#C4B587) are near-invisible against the page and
against each other. Confirmed visually on the golden report's cost band.

`--rule-strong` is also the resting border of the currency toggle
(`styles.ts:115`) — the only interactive control in the report, at 2.08:1.
(It clears 3:1 once pressed, when the border becomes brass.)

Mitigating: the legend and the `<desc>` both carry the value in text, so no
information is *only* in colour. Still worth fixing — the stacked bar is
currently decoration pretending to be a chart.

### S8. `?? 0` fabricates a "£0.00" in the situs table

`render.ts:270-272`: `person.usSitus?.totalBase ?? 0`, and the same for
`nonUsSitus` and `unclassified`, each wrapped in `money()`. If the engine did
not produce a total, the reader is shown a confident `£0.00` rather than an
em-dash. `money(undefined)` already returns `"—"` (format.ts:17) — the `?? 0`
defeats it. In an "estate exposure sketch", "zero US-situs assets" and "we could
not compute your US-situs assets" are very different statements.

### S9. `--offline` is half-wired for `--narrate`

**SPEC §9:** *"support `--offline` flag that disables **all** egress"*.

`NarrateDeps.offline` exists and is honoured (`narrative.ts:106, 120`), but
nothing sets it: `generateNarrative` (`commands.ts:432-456`) does not accept or
forward an offline flag, and `main.ts:137-183`'s `report` case never reads
`flags.offline` — it is read only in the `ingest` case (`main.ts:106`).
`meridian report --narrate --offline` therefore makes the API call. SPEC §10
schedules `--offline` for Phase 6, so this is not out of sequence — but the
switch that exists and does nothing is worse than the switch that does not exist
yet, because it reads as implemented.

### S10. The entire Phase 5 CLI surface and the only Phase 5 egress path are untested

`test/cli.test.ts` calls `cmdReport` four times (`:161, 204, 363, 394, 417`) and
never once with `html: true` or `deck: true`. `narrateSection` and
`generateNarrative` appear in no test file. So none of the following has ever
executed under test: writing `report-<asof>.html` / `deck-<asof>.html` through
`store.saveReport` (commands.ts:406-417); `main.ts`'s `--html` / `--deck` /
`--narrate` / `--benchmark` flag wiring; the audit row `narrateSection` writes;
the "a rejected section is simply absent" behaviour at commands.ts:449-453; or
the API request shape.

`test/report.test.ts` tests the pure renderer well. The wiring between the CLI
and the renderer is the untested part, and per SPEC §10 Phase 5 the deliverable
is `meridian report --html`, not `renderReport()`.

### S11. The 20-year drag chart does not show the drag

`render.ts:136-143` + `charts.ts:91-133`, `.drag { height: 150px }`
(styles.ts:149). Two exponential curves plotted from a zero baseline over the
full terminal range, with the gap filled at `opacity: 0.16` brass
(`.c-gap`, styles.ts:155). At the golden ledger's 33.62 bps the two polylines
are visually a single line for the whole width, and the filled gap is invisible;
at 390px it is worse. Confirmed by screenshot.

§6.3 calls this screen "the yTree-killer moment". As drawn, all the information
is in the two legend rows and the sentence beneath, and the chart is a squiggle.
Plotting the *difference* (or breaking the y-axis, or annotating the terminal
gap on the chart) would make it say something. This is the one place §10's
"spend cleverness only in the report design" invites more, not less.

### S12. `overflow-x: hidden` makes the no-horizontal-scroll test unfalsifiable

`styles.ts:50` sets `body { overflow-x: hidden }` and
`test/report.test.ts:56` asserts that rule is present. Together they mean §8's
"horizontal-scroll explicitly forbidden" is verified by asserting that overflow
is *clipped*, not that it does not occur. Anything that overflows the viewport
is silently cut off instead of failing. (Nothing currently does overflow outside
a `.scroll` — I checked every element in `main` at 386px — but the guard does
not guard.) A test that measures `documentElement.scrollWidth <=
clientWidth` with the hidden rule disabled would be a real assertion.

### S13. PROGRESS.md tracks none of PHASE_REVIEW_4's SHOULD-FIX items, and two Phase 3 checkboxes are stale

PROGRESS.md records the Phase 4 gate as "7 MUST-FIX, 20 SHOULD-FIX, 16 NOTE"
(line 76) and then documents only the M1–M7 resolution (lines 77-106). There is
a "## Remaining PHASE_REVIEW_3 SHOULD-FIX" section (lines 203-236) but **no
Phase 4 equivalent**, so 20 findings from the previous gate have no recorded
status in the cross-session memory — neither carried forward nor dismissed.
Zero of the ten new Phase 4 SHOULD-FIX items appear in PROGRESS.md by name; I
spot-checked three and all three are still live in code (detail in the status
section below). One of them (PR4-S5, the unsettable growth assumption) is
directly entangled with M1 above.

The Phase 3 list that *is* tracked is broadly honest but has drifted: S7 is
fixed and the file contradicts itself about it (line 103 says it is closed,
line 227 still shows it unchecked), and S2/S6/S8 have each advanced materially
without the file recording it.

Given §12.5 ("the reviewer's MUST-FIX mechanism is the structural backstop
against the main loop marking its own homework") and CLAUDE.md's requirement
that PROGRESS.md carry "open must-fixes", the SHOULD-FIX ledger needs the same
discipline: one section per completed gate, re-verified rather than re-copied
when a phase closes.

### S14. `--narrate` runs the whole engine twice and validates against the wrong results object

`main.ts:156` calls `cmdReport` to produce a draft, narrates against
`draft.results`, then `main.ts:162` calls `cmdReport` **again**. Both calls run
the full engine, both write `results-<asof>.json` (the second overwriting the
first), and each takes its own `now()` — so `meta.generated_at` differs between
the object the narrative was validated against and the object the report
renders. Nothing currently depends on `generated_at` being in the allowed
numeral set, but the shape is wrong: validate against the object you render.
Pass `draft.results` (and its `generatedAt`) through instead.

---

## NOTE

**N1. Lighthouse: honestly recorded, and what would close it.** PROGRESS.md
lines 30-37 state the criterion is UNVERIFIED, name the reason, and list what
was checked instead. Confirmed accurate. To close it properly you need: a
Chrome-driven run (`lighthouse <url> --preset=perf --form-factor=mobile
--screenEmulation.mobile --throttling-method=simulate` plus the accessibility
category) against the report **served over http** — not `file://`, where the
PWA and several perf audits do not apply — for both the US/UK and UK-only
fixtures, with the JSON report committed under `test/` or quoted in PROGRESS.md
with its four category scores. The install requires network egress, which
`.claude/settings.json` denies, so this is a human-run step. Predict a
performance score near 100 (37KB, no requests, no fonts, no images, no layout
thrash) and an accessibility score below 95 until M6, S6 and S7 are fixed.

**N2. The budget and first-render requirements are comfortably met.** Measured
byte sizes: acceptance fixture report 27.4KB, deck 27.7KB, UK-only 19.4KB,
golden ingested ledger 37.4KB — against a 400KB budget. Zero network requests of
any kind (the test at report.test.ts:42-50 is a good one, asserting no `src=`,
no stylesheet link, no `@import` and no `https?://` anywhere). Nothing in the
page is hostile to §8's "first render <1s on a mid-range phone": one inline
`<style>`, two small inline scripts that run after content, hand-rolled SVG with
~120 rects and 2 polylines, no web fonts, no images, no data URIs beyond the
manifest, no layout-thrashing JS. The `clamp()`/`transition` work is trivial.

**N3. The §8 acceptance fixture exercises empty cost and performance sections.**
On `household-usuk-acceptance`, `costStack.total` is £0.00 / 0.00 bps with zero
lines, and `performance.portfolio` is `null` ("only one accepted snapshot date
is available"). So `test/report.test.ts` renders the cost section with no
charges, a degenerate drag chart where gross and net terminals are identical,
and the performance section's "Not enough accepted valuation dates" fallback.
The test at `:158-162` is conditional on a method that is never present. The
golden ingested ledger does exercise all of it (£1,418.00 / 33.62 bps, 5 cost
lines, TWR +1.27%, benchmark present, 6 per-account returns) — worth rendering
from in the tests too, and it is what I used for most of the browser work.

**N4. `Datum.tone` is dead code with a latent path to red.** `charts.ts:14-25`
defines four tones including `alert: "var(--alert)"`, and `grep -rn "tone:"
src/report/` finds no call site that sets one — every bar is brass. The dead
`alert` branch would emit `var(--alert)` with no awareness of `hasAlert`, so if
it is ever used in a report without critical flags it produces an undefined
custom property (rendering black, not red — but breaking the invariant's
intent). Either remove the tone machinery or thread `hasAlert` into it.

**N5. Print backgrounds are not forced.** There is no `print-color-adjust` /
`-webkit-print-color-adjust` anywhere in `src/`. Headless Chrome's
`--print-to-pdf` does emit them (I found `.9647 .9137 .9059`, the alert wash,
in the PDF content stream), but a user printing from the browser dialog gets
"Background graphics" **off** by default — in which case `.critical-row`'s wash
and every `.swatch` in the two legends lose their colour. The SVG chart fills
are safe (they are `fill` attributes, not CSS backgrounds) and survived in the
PDF. Adding `print-color-adjust: exact` to `.critical-row` and `.swatch` would
make the printed PFIC table and the cost legend readable.

**N6. Print output is otherwise sane A4, verified.** Headless Chrome
`--print-to-pdf`: MediaBox `594.96 × 841.92` pt = A4; the US/UK report paginates
to 6 pages, the golden ingested report to 9. `@page { size: A4; margin: 16mm
14mm }` (styles.ts:209), `table { min-width: 0; font-size: 9pt }` in print
(styles.ts:216) correctly removes the M2 floor so tables fit the 182mm content
width, `.no-print` hides the toggle (styles.ts:213), and the deck's
`min-height: 100svh` is correctly replaced by `break-after: page`
(styles.ts:229). This criterion is met.

**N7. The type stacks are macOS-first.** `DISPLAY_SERIF` leads with Iowan Old
Style and `BODY_SANS` with Seravek (styles.ts:17-18) — both macOS-only. §8's
"characterful display serif" and "clean humanist sans" therefore land on
Georgia/Palatino on Windows and on a generic serif on Android (Georgia is not
bundled there), and body text falls to Segoe UI or Calibri. The comment at
styles.ts:13-15 states the reasoning (the no-CDN rule forbids web fonts) and it
is the right call — but "tabular-lining figures mandatory" is the part that must
survive, and it does: `font-variant-numeric: tabular-nums lining-nums` on
`.num, table, .pair, .c-value, .figure` (styles.ts:62) plus `lining-nums` on
body (:57), confirmed computed as `tabular-nums lining-nums` on the tables in
the browser.

**N8. The manifest object is duplicated verbatim** between `manifestLink`
(render.ts:372-379) and `pwa` (render.ts:384-391). If M4 is fixed this
disappears; noting it so it does not survive the fix.

**N9. `money()` always groups with `en-GB`** (format.ts:18) regardless of the
currency being formatted, so USD figures use UK grouping. Identical output for
GBP/USD/EUR at these magnitudes; §8 says "formatted per locale", so worth a
decision rather than an accident. The important half of that sentence — "explicit
currency symbols always (never bare numbers)" — is correctly enforced:
`money()` cannot return a bare number, and report.test.ts:106 asserts it.

**N10. The `.scroll` regions are announced correctly.** All 12 carry
`role="region"` + a distinct `aria-label` + `tabindex="0"` (render.ts:72, 99,
146, 168, 190, 220, 227, 285, 293, 301, 358) — this is exactly the WAI-recommended
pattern for a keyboard-operable scrollable region, and each label is meaningful
("PFIC holdings", "Wrapper treatment", "Source documents"). Verified in the
browser: 13 tab stops in DOM order, toggle first then the regions in reading
order, all with a visible brass focus ring. The currency toggle is a real
`<button>` with `aria-pressed` toggled in the handler (render.ts:428) and a
label that updates (`:429`) — fully keyboard operable. The `aria-hidden="true"`
+ `focusable="false"` decision on the bar SVGs (charts.ts:42, 148) is right: the
label and the formatted value sit beside each bar as real text, so the bar adds
nothing; the two charts that *do* carry information the text does not (the cost
band and the drag projection) correctly keep `role="img"` with `<title>` and
`<desc>` (charts.ts:81-82, 122-123). Heading order is clean: one `h1`, six `h2`,
`h3` only beneath an `h2`, no skips (verified on the golden report's 23
headings).

**N11. §9 identity check: clean.** The rendered report contains redaction tokens
only — persons as `P1`, accounts as `A1`…`A6` beside institution names, and no
household name anywhere: `options.title` (render.ts:16, 437) defaults to
"Wealth report · <date>" and `cmdReport` (commands.ts:406-417) never passes one.
The footer shows the household ULID (render.ts:477), not a name. Instrument
names are fund names, not client identifiers. The §9 disclaimer is present
verbatim in every report and asserted (report.test.ts:150-156). The one place
identifiers can escape is the narrative payload — that is M5, and it is about
egress, not about the rendered document.

**N12. `render.ts` is 485 lines** against §10's 500-line rule. Within limits,
but the US-connected section alone is ~100 lines and will grow; the natural
split is one module per report section.

**N13. Escaping is applied consistently.** I traced every interpolation in
`render.ts`, `charts.ts` and `format.ts`: all document-derived strings
(instrument names, filenames, institutions, labels, explanations, warnings, the
title) pass through `esc()`; chart fills come from a constant palette; the
manifest is `JSON.stringify`-then-`<`-escaped for the inline script
(render.ts:392) and percent-encoded for the data URL (render.ts:380). `esc()`
does not escape `'`, which is safe here because every attribute is
double-quoted. No injection found.

---

## Status of the SHOULD-FIX items PROGRESS.md carries forward

PROGRESS.md lines 203-236 list the PHASE_REVIEW_3 SHOULD-FIX items it says are
still open. Verified against the code at `4f64fe9`:

| Item | PROGRESS.md says | Verified at HEAD |
|---|---|---|
| S1 unrounded floats in the `usconnect` result | open | **open, correctly** — `roundHalfEven` is not imported anywhere in `src/usconnect/`; raw sums at `situs.ts:25,55`, `wrapper.ts:31`, `currency.ts:50,79`, `pfic.ts:78-80,113`, and the de-minimis comparison at `pfic.ts:101-102` compares an unrounded sum against an unrounded converted threshold |
| S2 `Math.round` where fx-policy mandates half-even | open | **partly fixed** — `consolidate.ts:161` now uses `roundHalfEven`; `risk.ts:70,91,92` still use `Math.round(x*100)/100` on money |
| S3 `convert()` rounds inside the engine | open (annotated partial) | **partly fixed, as annotated** — `.exact` exists and aggregating callers use it (`consolidate.ts:104-107`, `results.ts:99,195`), but `fx.ts:130,154` still round `amount` and `toCurrency` (`fx.ts:171-173`) still returns the rounded value |
| S4 hardcoded USD pivot, two policy values ignored | open | **open, correctly** — `fx.ts:140` `const pivot = "USD"`; `cross_rate_rule` (`fx.ts:48`) and `rate_decimal_places` (`fx.ts:49`) are declared, read from params, and never used; inverted (`fx.ts:91`) and triangulated (`fx.ts:152`) rates are returned at full float precision |
| S6 cost reconciliation against hand-typed constants | open | **partly advanced** — the four fee lines now come from the committed expected-parse fixture (`test/engine-cost.test.ts:11,15-20`), but `DISCLOSED_TOTAL = 1158.0` and `AVERAGE_VALUE = 82000.0` (`:12-13`) are still hand-typed, and the bps denominator has no document source; `parse-output.schema.json` has no field for either |
| S7 only two engine entry points take a ledger | open | **fixed in substance — the checkbox is stale.** Both missing adapters now exist: ledger→`CostStackInput` (`results.ts:88-148`) and ledger→`Valuation[]`/`Flow[]` (`cli/performance-adapter.ts`). PROGRESS.md:103 already says so while PROGRESS.md:227 still shows it unchecked — the file contradicts itself. Residual: both adapters live in `src/cli/`, so §6's "pure functions `(ledger, params, options) → results`" is still not literally true of `src/engine/`'s public surface |
| S8 `latestHoldings` disposal + staleness | open | **half fixed** — the staleness half shipped in Phase 4/5 (`results.ts:55-56,247-255` → `render.ts:80-101` → `format.ts:68-77`), which is what satisfies §8's per-account data-freshness requirement. Disposal is untouched (`consolidate.ts:56-65`) and the blast radius has grown: `usconnect/ledger-view.ts:94` now shares `latestHoldings`, so a sold position would inflate the PFIC table, the critical count and the situs columns as well as the consolidation |
| S9 the two currency columns are two different measurements | open | **open, and now more visible.** The base column converts each holding at its own snapshot date (`consolidate.ts:104`); the secondary converts the aggregate at the report `asof` (`consolidate.ts:149-159,184`). `consolidation.warnings` carries three messages, none about mixed conversion dates. Nothing in `src/report/` discloses it — the only prose beside the pair is `render.ts:467`, "Two currencies, one truth", which asserts the opposite. Phase 5 has now built the entire report around this pair, so this is the phase where it should be stated |
| S10 concentration per-instrument, against total not investable wealth | open | **open, correctly** — `risk.ts:47-54` filters `consolidation.byInstrument` on `shareOfTotal`; `shareOfTotal` is `exactBase / total` including cash (`consolidate.ts:211`), while `params/shared/asset-classes.json:53-56` sources the threshold as "5% of **investable wealth**". No issuer key exists on `Slice` or on ledger instruments, and no scope limitation is pushed to `warnings` |
| split `params/shared/pfic-rules.json` | open | **open, correctly** — no `situs-rules.json` or `usconnect-rules.json` exists; the misfiling is still load-bearing in client-facing source strings at `usconnect/index.ts:79,89` |

Net: PROGRESS.md's carried-forward list is broadly honest — seven of ten rows
are accurate. One (S7) is stale and contradicts the same file's own Phase 4
notes; three (S2, S6, S8) have advanced materially without the file recording
it. None of that is a Phase 5 defect; it is the tracking hygiene S13 is about.

**And the PHASE_REVIEW_4 SHOULD-FIX items are not tracked at all.** Confirmed:
PROGRESS.md:75-76 records the count only ("7 MUST-FIX, 20 SHOULD-FIX, 16 NOTE");
:77-107 covers M1–M7; there is no "Remaining PHASE_REVIEW_4 SHOULD-FIX" section
anywhere. Zero of the ten new Phase 4 SHOULD-FIX items (PHASE_REVIEW_4.md:339-471)
appear in PROGRESS.md by name, in either direction. Spot-checking three shows
they are silently un-tracked rather than quietly done:

- **PR4-S5** (growth assumption is an unsettable literal) — `results.ts:20`
  `DEFAULT_GROWTH_ASSUMPTION = 0.05`; `BuildResultsInput.growthAssumption`
  exists (`results.ts:71`) but no CLI flag reaches it (`grep growth
  src/cli/main.ts src/cli/commands.ts` → nothing). **This is now load-bearing
  for M1 above**: the report hard-codes the same 0.05, so the two literals agree
  today only by coincidence, and the moment PR4-S5 is fixed by adding the flag,
  M1 starts producing contradictory figures in the field.
- **PR4-S6** (params year hardcoded, ignores `--asof`) — `results.ts:190-191`
  `readParams("us/2026.json")` / `readParams("uk/2026-27.json")`.
- **PR4-S7** (`NETWORK_AUDIT.md` written relative to cwd) — `commands.ts:194`
  and `:446`, the second of which is the new Phase 5 narrate path.

---

## Verdict

**Phase 5 is not complete.** Seven MUST-FIX items are open. The report's design
is the strongest work in the repo so far and most of §8's design direction is
honoured exactly as written — but "the dual-currency ledger column is the
signature" (M3), "designed at 390×844 first" (M2), "installable as a PWA when
served" (M4), "a paged summary" (M7) and "WCAG AA contrast" (M6) are five
distinct §8 requirements that the current build does not meet, and M1 and M5
are violations of §2's two founding principles — deterministic core, and
redaction before egress — in the module where those principles are cheapest to
uphold.

**Counts: 7 MUST-FIX, 14 SHOULD-FIX, 13 NOTE.**

Of §8's five acceptance criteria: **<400KB** is met with a 10× margin
(N2); **print produces sane A4** is met and verified (N6, with N5 as a caveat);
**a PFIC-free household shows no red anywhere** is *true of the product* — I
verified it on a US-person household with zero critical flags — but the test
that claims it is vacuous (S3); **offline reopen** works only because the file
has no dependencies, and the PWA machinery meant to deliver it does not run
(M4); and **Lighthouse** remains honestly unverified (N1), with three findings
here that it would have caught.
