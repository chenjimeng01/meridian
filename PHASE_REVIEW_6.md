# PHASE REVIEW 6 — Hardening (SPEC §10)

**Reviewer:** the main loop, at the operator's explicit instruction ("finish and
review yourself"). This is a WEAKER guarantee than reviews 2–5, which the Opus
structural-reviewer subagent wrote: builder and reviewer are the same model
here, which is exactly the failure mode §12.5's MUST-FIX mechanism exists to
prevent. Reviews 4 and 5 each found real defects in work the main loop had
already reported as done — a privacy leak, a cost figure wrong by a factor of
three, tables running off the target device. Weight this document accordingly,
and consider re-running it with the Opus agent.

**Scope:** commit `c32a4fd` plus the id-guard fix below. 178/178 green,
typecheck and lint clean, `scripts/demo.sh` runs both households
start-to-finish.

## MUST-FIX

(none found — see the caveat above about who is looking)

## Found and fixed during this review

- **Ids became path segments unvalidated.** `loadRun`, `loadParkedRun` and
  `parkRun` interpolated a CLI-supplied run id straight into a path, so a run
  id containing `../` could read or write outside the household directory. A
  probe was refused only because the crafted target did not exist, not because
  anything checked. `assertSafeId` now constrains ids to
  `[A-Za-z0-9_-]{1,64}` at every point one reaches the filesystem.

## SHOULD-FIX

1. **The manual template and its redacted working copy are mode 0644**, while
   the parked `source.txt` beside them is 0600. The template is redacted and
   initially empty, so the exposure is small — but an operator fills it with
   figures and it then sits world-readable next to files the system took care
   to protect. `saveRun` should chmod like `parkRun` does.
2. **`manualTemplate` infers the period and currency by regex over the redacted
   text.** That is the same class of inference §7.1 refuses to trust for
   instrument metadata. It is defensible here (the operator is looking at the
   document and will correct it, and a wrong period fails review), but it
   deserves the same scepticism: consider leaving both blank.
3. **No test drives `meridian manual` through the shell**, only through the
   command functions. `test/cli.test.ts` has the precedent for a binary-level
   test and manual entry is now a documented operator route.
4. **`--offline` is enforced at `main.ts`, not in the library.** A caller using
   `cmdIngestLive` directly can still transmit. The extractor's own
   `OfflineError` covers the extraction path, but the guarantee would be
   stronger if it lived with the code that transmits rather than with the
   argument parser.

## NOTE

- **§2 determinism holds.** A repo-wide grep for `Date.now`, `new Date(`,
  `Math.random` and `process.env` across `src/` returns hits only in
  `src/cli/main.ts`, which is the declared clock boundary.
- **§10's file-size rule holds**, but `src/report/render.ts` is 577 lines and
  is the largest file in the repo. It is a sequence of independent section
  renderers and would split cleanly; it should be split before it grows again.
- **The §10 Phase 6 gate is met**: `scripts/demo.sh` builds the US-connected
  and UK-only households start-to-finish and was re-run after every change in
  this phase. The UK-only report was verified to contain no US section and no
  occurrence of the alert colour.
- **§9's offline claim is now true rather than aspirational.** A test drives a
  complete report with no egress at all, reaching it through manual entry for
  the document the parser could not read. Before this phase that path
  terminated at `parse-runs/failed/`.
- **Manual entry does not weaken acceptance.** It produces a parse output that
  is schema-validated and then goes through the ordinary review flow; nothing
  reaches the ledger unreviewed, and the figure is fingerprinted against the
  original document's bytes exactly as an extracted one is. The deliberately
  blank institution field fails `minLength: 1`, so an unfilled template cannot
  be submitted by accident — the schema makes the operator read the document.

## Still open across all phases

Lighthouse remains unrun and unverifiable here (§8). Carried SHOULD-FIX items
from reviews 3–5 that do not affect a reported figure remain open and are
listed in PROGRESS.md.

**Verdict:** Phase 6's stated gate is met and v0 is feature-complete against
SPEC §10. One real defect (unvalidated path segments) was found and fixed
during the review; four SHOULD-FIX items are recorded. The material caveat is
not in the findings but in the reviewer: this is the one phase gate not
independently reviewed, and the two most serious defects of the whole build
were found by the independent reviewer in phases the main loop had already
declared finished.
