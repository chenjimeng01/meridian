# Four-perspective review — verdict and plan

Four reviewers were asked to evaluate Meridian, each told to actually use it
rather than read about it: a **Head of Compliance** at an FCA-authorised firm, a
**CTO** assessing whether to own the codebase, a **Chartered Financial Planner**
who would use it on Monday, and **Eleanor** — a US-citizen client in London,
allowed to see only what a client sees.

They disagree about almost everything except one thing, and that agreement is
the finding.

---

## Is it a good tool?

**Yes, and not yet safe to use on a client.** All four independently rated the
core idea as genuinely differentiated and the execution as better than expected,
and all four found the same class of problem.

| | Verdict |
|---|---|
| Compliance | Own/synthetic data: **yes**. Real client data internally: **no**. Client-facing: **no**, and a disclaimer will not fix it. |
| CTO | **Build on.** "The data model, the FX policy, the params sourcing and the supply chain are the work of someone who should be trusted with a larger codebase." Nothing touches real money until three things are done. |
| Planner | **Yes, with changes.** Would use it today as an internal PFIC/situs discovery tool. Would not send the report to a client. |
| Eleanor | Wants her adviser to keep using it — **not to send it to her**. Would pay £750–£1,000/yr alongside a meeting; £2,000–£2,500 if it projected her future and costed the PFIC problem. |

**What's genuinely good**, agreed across reviewers: the PFIC cascade with its
statutory sourcing and its refusal to classify unconfirmed metadata; situs
following incorporation rather than custody; the acceptance log and data
appendix ("better provenance than our back office" — Compliance); the
deterministic-core discipline; and the narrative validator, which the planner
called "a compliance story worth more than mobile-first."

**The single most valuable thing it does**, per the planner: a per-holding,
per-wrapper PFIC schedule with values and citations, from raw statements, in
under a minute. *"That is four hours of my life, done better than I do it."*

---

## The finding underneath all the others

The CTO put it best: **this codebase has a habit of naming a guarantee and then
implementing something narrower** — and the naming is convincing enough that
reviews have repeatedly accepted it.

Four independent instances, all now confirmed:

1. The pre-commit rail promised to refuse commits containing a vault value. It
   scanned `Object.values()`, but the vault stores identifiers as **keys**. A
   client's name passed. *(Fixed, `c588166`.)*
2. The README claimed an "encrypted-at-rest vault". It writes plaintext at mode
   600. *(Corrected, `c588166`.)*
3. "Every slice sums back to the total, exactly" could not fail for its stated
   reason: the residual plug absorbed whatever the slicing got wrong. Deleting
   the joint-ownership split left all 188 tests green. *(Fixed, `b972f4e`.)*
4. A "no tax literals" test that tests no literals, and an account-number regex
   fitted to the fixtures.

**The rule going forward:** anything — code, test or params entry — that claims
to enforce something must ship with a test proving the enforcement *fails when
it should*. Not that it passes when things are fine.

Related, from the CTO's mutation run: **six of nine deliberate mutations
survived the entire suite**, including withdrawals counted as contributions and
every per-category cost forced to zero. The engine tests are excellent — genuine
hand-derived oracles. The discipline stops at the `src/engine/` boundary, which
is exactly where `results.ts` and `performance-adapter.ts` live.

---

## What to fix, ranked

### Tier 0 — before anyone else sees it

| # | Fix | Why | Source |
|---|---|---|---|
| 0.1 | **Decide the public site's status**: strip to the worked example, or add privacy notice, controller identity, terms and a CSP. | An employee of an authorised firm publishing a page that invites statement uploads and returns US tax conclusions, under their own name. The only finding with a live clock. | Compliance |
| 0.2 | ~~Pre-commit rail~~ | **Done** `c588166` | Compliance |
| 0.3 | ~~Residual hiding slicing errors~~ | **Done** `b972f4e` | CTO |
| 0.4 | **Correct the SIPP badge.** Cites Rev. Proc. **2014-55 — the Canadian RRSP procedure**; the SIPP authority is **2020-17**, and the position depends on Art. **1(5)**'s saving-clause carve-out, unmentioned. A green OK downgrades £111,342 of real PFICs to WARN. | *"Everything else on my list produces an argument. This one produces a claim."* | Planner |

### Tier 1 — the report contradicts itself

Cheap, and every reviewer hit them.

| # | Fix | Detail |
|---|---|---|
| 1.1 | **One holding, one percentage.** Top-positions measures against total wealth; concentration against investable. Both shown, neither labelled. | *"Once I found it I started doubting everything above it."* — Eleanor |
| 1.2 | **Label performance periods.** The by-account column shows 15.7% next to 0.4% over 2 years and 2 months respectively, headed simply "Return". The dates are in `perAccount.from/to` and are discarded by the renderer. | *"The line most likely to blow up a meeting."* — Planner |
| 1.3 | **"At least" on the cost headline.** 33.62 bps where 55% of the portfolio disclosed no charges; the caveat is thousands of pixels below. Render `costStack.byAccount` bps beside it. | Planner, Eleanor |
| 1.4 | **Rehydrate names.** SPEC §9 requires reports to replace tokens at generation. Unimplemented — the client-facing document calls people `P1`/`P2` and accounts `A1`–`A6`. | All four |
| 1.5 | **Total assets, not total wealth**, until liabilities exist. | Planner |
| 1.6 | Fix `−0.3%` where the components round to `−0.2%`; `"linked across 1 sub-periods"`; headers breaking as `STATU/S`; the currency toggle not reaching charts or the cost legend. | Eleanor |

### Tier 2 — render what the engine already computes

The planner's top-ranked item, and the highest value-per-hour work in the whole
list. All of this is computed today and thrown away before rendering:

PFIC total (**£227,744.50, 51.5% of wealth**) · `usEstate.basis` (P1's $15m
exemption vs P2's **$60,000** cliff) · `ukIht.scope` · per-account cost bps ·
per-account performance dates · the **entire `ukResident` wrapper column** ·
geographic split · currency-of-life mismatch · liquidity tiers.

> The situs table currently emphasises the wrong person. P1 (US citizen,
> $15m exemption) shows £70,340 and reads as a threat; P2 (non-US,
> **$60,000** exemption, 40% over) shows £14,346 and reads as benign. The
> engine knows which one matters. — Planner

### Tier 3 — correctness the reviews surfaced

- **Idempotent ingest on sha256** — re-ingesting the same document duplicates it. *(CTO's #1.)*
- **Rewrite the flow/return path**; pull the per-account return table until done. Withdrawals are currently counted as contributions and nothing catches it.
- **Fee-bearing accounts render as free** when their snapshots can't be FX-valued (`averageValue = 0` → `0 bps`). Already reachable: the demo drops snapshots.
- **Test the compliance controls.** `assertNoAdvice`, `assertNarrationSafe` and `redactResultsForNarration` — the §9 egress and advice boundaries — have **no tests**.
- **ADR treatment is backwards**, and domicile is inferred from the ISIN prefix, so a Shell ADR would be stamped US-situs.
- **Joint accounts default to 50/50**, which is specifically wrong for a US-citizen/non-US-spouse couple — the archetypal client (s2040(a), not s2040(b), where s2056(d)(1)(B) applies).
- **Stale UK dividend rates** (8.75/33.75 marked `published`; Nov 2025 Budget raised the first two by 2pp from April 2026 — verify).
- **Adversarial test data**: no withdrawals, no negatives, no zero values, no empty ledger, no missing ISIN anywhere in any fixture.
- **Push one real PDF through and let it fail.** Every fixture is self-authored.

### Tier 4 — records and data protection, before real client data

- **Reports are silently overwritten** — you can reconstruct the inputs perfectly but not what the client received. Content-address them.
- **No deletion capability at all** — no DSAR erasure path. Must cover `documents/`, `parse-runs/failed/` (raw, unredacted) and reports.
- **Uniform mode 600** across `data/` — `ledger.json` is 644 beside a 600 vault.
- **Audit rows need household and document ids** — you cannot answer "whose data went to the API on 3 March" inside 72 hours.
- **Operator initials are unauthenticated free text.**

---

## What to build, ranked by what changes a working week

1. **Liabilities and CGT base cost.** A mortgage object and an acquisition-cost field. Everything else is gated behind this: no net worth, no IHT, no CGT, no bed-and-ISA, no s988 FX gain — and the word "wealth" is wrong without it.
2. **The UK-resident tax layer, switched on.** The rules are already written and unrendered: non-reporting funds (**£45,434 here, taxed as offshore income gains at up to 45%**), the gilt CGT exemption, the personal savings allowance, FBAR/8938 threshold checks against numbers already in params. Mostly wiring, and it doubles the addressable client base.
3. **The review screen as a form, keyed on ISIN.** Pre-fill domicile from the ISIN, type from the parse; leave `us_registered` as the one real decision. Turns the slowest step (hand-authored JSON) into the fastest.
4. **A covering page.** Client name, three plain sentences, and for the red count: what it costs and one first step. Eleanor's single most-wanted change — *"the report's job right now stops at 'here is a problem'. It needs to go one sentence further."*
5. **Allowance and multi-year tracking.** ISA and pension allowance used/remaining, carry-forward, CGT AEA, two `--asof` dates side by side. Turns a valuation into a review pack.

Below the line but cheap: RSUs and DB pensions in the wrapper enum; a REIT rule; HMRC/IRS tax-year FX rates alongside spot; a beneficial-ownership field.

---

## The strategic question the panel raises

Compliance and the planner arrive at the same place from opposite directions.

Compliance: per-holding severity labels on named investments in named wrappers
are a personal recommendation **in substance** (RAO Art. 53) — the opinion is
supplied by the severity taxonomy itself, and a footer cannot cure it. The US
content is Circular 230 territory with no US-qualified person behind it.

The planner: the report is not client-ready anyway, and the value is in
remediation — which funds to unwind, in what order, against which allowances —
which does not exist yet.

**Their shared answer:** make it explicitly **adviser-facing**. An analysis
input that never leaves the firm and feeds a suitability report a human writes
and signs. That resolves most of the perimeter problem at a stroke, keeps
everything the panel liked, and matches how Eleanor said she'd actually want it
used — *"sat next to my adviser, with them talking me through it, it would be
excellent."*

The alternative — neutering the severity model into genuine information, with
no colour, no ranking and no "worry" — keeps it publishable but throws away the
thing that makes it worth using.

That is a product decision, not an engineering one.
