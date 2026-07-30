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

## See it working

```sh
npm install          # also installs the §9 pre-commit rail via the prepare script
./scripts/demo.sh    # builds two households from synthetic statements, opens the report
```

That ingests 15 synthetic statements from 5 fictional institutions, accepts
each parse, confirms instrument metadata, and produces:

| | |
|---|---|
| the client report | mobile-first, ~40KB, self-contained, printable |
| a screen-share deck | `--deck`, one idea per slide |
| a UK-only household | to show the US-connected section vanish entirely |
| a review screen | the redacted diff an operator accepts from |

Add `--serve` to host them over http (`./scripts/demo.sh --serve`), which is
how to look at the report on a phone — it is designed at 390px first.

## The browser version

```sh
npm run serve:web     # builds docs/ and serves it at http://localhost:8799
```

`docs/` is a static site — it is what GitHub Pages serves. It runs the **same**
engine as the CLI: the identical redaction, parser, consolidation, PFIC cascade
and report renderer, compiled to run in the page rather than reimplemented, so
the two cannot drift and produce different numbers.

Nothing is uploaded anywhere. There is no server to upload to: a statement you
choose is read by the page, processed in the tab, and discarded on reload
unless you press Download. That is the only way a hosted interface is
compatible with the local-first rule in `SPEC.md` §2.2.

The desktop CLI remains the tool for real work — it keeps a durable ledger, an
encrypted-at-rest vault, an acceptance audit trail and the parked-document
workflow. The browser build is for showing someone what this does.

## Using it on your own documents

```sh
meridian() { node --import tsx src/cli/main.ts "$@"; }

meridian households create --config my-household.json     # names/addresses -> the vault only
meridian ingest statement.pdf --household <id>            # PDFs need pdftotext on PATH
meridian review <run-id> --household <id> --accept-all \
        --confirm-metadata instruments.json               # or --decisions for line-by-line
meridian report --household <id> --asof 2026-06-30 --html
```

If a statement is in a layout the parser does not recognise it is parked
rather than dropped, and you enter it by hand:

```sh
meridian manual <parked-run-id> --household <id>                  # writes a template
meridian manual <parked-run-id> --household <id> --input filled.json
```

Manual entry rejoins the ordinary review flow — it is a different way to
produce the extraction, not a way to bypass acceptance. Add `--offline` to any
command to refuse all network egress; parsing then relies on the deterministic
extractor and manual entry.

Copy `test/fixtures/household-config.json` as a starting point. Confirming each
instrument's type, domicile and '40 Act registration is what unlocks the
US/UK tax analysis — until an operator confirms them, every holding is
reported as "needs classification" rather than assumed safe.

**Before any third-party data**, work through `PRE_LAUNCH.md`. v0 is for
synthetic and your own data only.

## Running the tests

```sh
npm test
```

`npm install` runs `prepare`, which points git at the tracked `.githooks/`
directory. That hook refuses any commit containing personal-data patterns or a
value recorded in a local vault — run it manually with `npm run scan`. If you
clone without installing, set it yourself: `git config core.hooksPath .githooks`.

Node 20+ required. No database, no build step for report output: the ledger is
human-readable JSON on disk and reports are self-contained single-file HTML.

## Not advice

Analysis and information only. Not a personal recommendation. Not tax advice.
US tax outcomes depend on elections and filings not visible to this system.
