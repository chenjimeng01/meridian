# Meridian — working rules for Claude Code

Read `SPEC.md` before doing anything. It is the contract; this file is the operating checklist.

## Non-negotiables (from SPEC §2)

- Deterministic core, AI at the edges. An LLM never computes a number that appears in a report.
- All tax rates, allowances, thresholds live in `/params/**` with sources — never a literal in engine code.
- Golden tests everywhere. `npm test` must be green before a phase is complete. Never rewrite golden fixtures to make tests pass.
- Mobile-first (390×844) is a build constraint, not polish.
- Everything is a file; `data/` is gitignored and never committed.

## Process rules

- **Update `PROGRESS.md` after every completed step** (current phase, last completed step, open must-fixes). This is the cross-session memory for the long-run driver.
- **Git commit at every step boundary** with the step name in the message.
- Phase gates (SPEC §10): a phase is complete only when its acceptance tests pass AND the structural review (Opus agent) has zero open MUST-FIX items in `PHASE_REVIEW_{n}.md`. Do not begin the next phase before that.
- At each phase start, restate the acceptance criteria as failing tests first.
- Keep every module under 500 lines per file. Boring code in the engine; spend cleverness only in the report design.
- Agent policy (SPEC §12): janitor (Haiku) after edits, cleaner (Sonnet) at step boundaries, structural-reviewer (Opus) at phase gates, deep-technical (Fable 5) for tax/maths/algorithms and any bug not fixed in two attempts.
- Every external API call is appended to `NETWORK_AUDIT.md` (timestamp, endpoint, redaction confirmation). No egress with unredacted data — ever.
- Synthetic/test data only until `PRE_LAUNCH.md` prerequisites are met.
