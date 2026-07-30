# Meridian — Cross-Border Wealth Intelligence Platform (v0)

A statement-based total-wealth intelligence platform: upload custodian/platform/bank
statements as PDFs, parse them into a canonical wealth ledger (human-confirmed),
and produce a mobile-first consolidated report — with first-class US/UK
cross-border intelligence (PFIC detection, wrapper conflicts, situs exposure).

See `SPEC.md` for the full build specification and `PROGRESS.md` for build state.

## Clean-sheet declaration

This is a personal-time, clean-sheet project. No employer code, data, documents,
or other intellectual property has been referenced, imported, or reproduced in
this repository. All statement fixtures are synthetic and describe fictional
institutions, people, and holdings. v0 handles synthetic/own data only; the
prerequisites for handling any third-party client data are tracked in
`PRE_LAUNCH.md` (ICO registration, DPIA, retention policy, regulatory-perimeter
review) and are not met.

## Principles (short form)

- **Deterministic core, AI at the edges** — every reported number comes from
  pure, unit-tested TypeScript; LLMs only extract documents, draft narrative,
  and suggest instrument matches (always human-confirmed).
- **Local-first, privacy by construction** — client data stays on local disk;
  anything sent to the Anthropic API is redacted first, and every call is logged
  in `NETWORK_AUDIT.md`.
- **Versioned parameters** — every tax rate and threshold lives in
  `params/{jurisdiction}/{tax_year}.json` with sources; no constants in engine code.
- **Golden tests everywhere** — `npm test` gates every phase.

## Running

```sh
npm install
npm test
```

Node 20+ required. No database, no build step for report output: the ledger is
human-readable JSON on disk and reports are self-contained single-file HTML.

## Not advice

Analysis and information only. Not a personal recommendation. Not tax advice.
US tax outcomes depend on elections and filings not visible to this system.
