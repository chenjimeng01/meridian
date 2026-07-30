# Meridian — instruction manual

Two ways to use it. Pick by what you're doing.

| | Browser | Desktop (CLI) |
|---|---|---|
| Where | <https://chenjimeng01.github.io/meridian/> | your machine |
| Good for | showing someone in 30 seconds | real work |
| Keeps a ledger between sessions | no | yes |
| Vault, audit trail, parked documents | no | yes |
| Reads PDFs | no (convert first) | yes (needs `pdftotext`) |

Both run the **same** engine, so both produce the same numbers from the same
statements.

**Before anything else:** this handles synthetic data and your own data only.
`PRE_LAUNCH.md` lists what must be done before anyone else's data goes near it
(ICO registration, DPIA, retention policy, regulatory-perimeter review). None
of it is done.

---

## 1. The browser version

Open <https://chenjimeng01.github.io/meridian/>.

Nothing you load is uploaded. The page is static — there is no server to send
anything to. Your statement is read by the page, processed in the tab, and gone
when you reload unless you press Download.

**Step 1 — Add statements.** Press **Load the worked example** to see it work
immediately with 15 synthetic statements. For your own, use **Choose files…**
(plain text) or paste the text of a statement.

**Step 2 — Confirm what the instruments are.** For each holding, set its type
and two-letter domicile, and tick "US-registered fund" if it is a US '40 Act
fund. This is not busywork: until you confirm, every holding is reported as
"needs classification" rather than assumed safe, so **the US tax analysis stays
blank until you do this**. See §4 below for why.

**Step 3 — Build the report.** Set the "as at" date, press **Build it**. The
report appears below. Download the report, the results JSON, or the ledger.

**Clear everything** wipes the session.

---

## 2. The desktop version

```sh
git clone https://github.com/chenjimeng01/meridian.git
cd meridian
npm install          # also installs the pre-commit rail that blocks committing PII
npm test             # 178 tests should pass
```

There is no installed binary. Define a shell function:

```sh
meridian() { node --import tsx src/cli/main.ts "$@"; }
```

See everything working first:

```sh
./scripts/demo.sh            # builds two households, opens the report
./scripts/demo.sh --serve    # serves them, so you can open it on your phone
```

---

## 3. The real workflow, step by step

### 3.1 Create a household

Write a config. Copy `test/fixtures/household-config.json` and edit:

```json
{
  "base_currency": "GBP",
  "secondary_currency": "USD",
  "persons": [
    {
      "token": "P1",
      "names": ["Jane Smith", "J Smith", "Smith"],
      "tax_profile": {
        "uk_resident": true,
        "uk_domicile_status": "ltr_flag",
        "us_person": true,
        "us_person_basis": "citizen",
        "state_exposure": "NY",
        "treaty_positions": ["uk_us_dta_pension_art17_18"]
      }
    }
  ],
  "addresses": ["12 Example Street", "London SW1A 1AA"],
  "account_owners": { "A1": ["P1"], "A2": ["P1"] }
}
```

- **`names`** — list every variant that appears on statements. Redaction only
  replaces names it has been told about; anything else is *detected* and blocks
  transmission, but it won't be tokenised. More variants is better.
- **`uk_domicile_status`** — `ltr_flag` if UK-resident in 10 of the previous 20
  tax years (worldwide IHT scope under the post-2025 rules), else `not_ltr`.
- **`account_owners`** — maps account tokens to people. You won't know the
  tokens until you've ingested once; A1 is the first account seen, A2 the
  second, and so on. Ingest, look at the review file, then fill this in.

```sh
meridian households create --config my-household.json
meridian households list
```

Note the household id. Everything else needs `--household <id>`.

**Where things go** (`./data/<household-id>/`):

```
household.json    currency and tax profiles — names and addresses stripped
vault.local.json  the real names and account numbers. Mode 600. Never committed.
documents/        the original files, content-addressed by SHA-256
parse-runs/       one directory per parse, plus failed/ for parked documents
reports/          results JSON and generated reports
ledger.json       the canonical ledger
```

### 3.2 Ingest a statement

```sh
meridian ingest ~/statements/platform-q2.pdf --household <id>
```

This hashes the file, redacts it, parses it, matches instruments against what
you already hold, and writes a **review file**. Nothing enters the ledger yet.

PDFs are converted with `pdftotext` (`brew install poppler`). If it isn't
installed you get told so explicitly, and you can convert the file yourself and
ingest the text.

If the parser can't read the document it is **parked**, not dropped — see §5.

### 3.3 Review it

Open the review file the ingest command printed. It is safe to view anywhere:
names and account numbers are already tokens. It shows every proposed line, its
confidence, what changed against the ledger, and which instruments still need
their type and domicile confirmed.

Then accept. Simplest:

```sh
meridian review <run-id> --household <id> --accept-all --operator JS
```

Line by line, write a decisions file:

```json
{
  "operator_initials": "JS",
  "lines": [
    { "kind": "holding", "ref": "Thames Utilities PLC Ordinary 25p",
      "action": "reject", "note": "sold before period end" },
    { "kind": "holding", "ref": "Atlas Global Equity UCITS ETF",
      "action": "accept",
      "edits": { "units": 1750, "value": { "amount": 11042.50, "currency": "GBP" } } }
  ]
}
```

```sh
meridian review <run-id> --household <id> --decisions decisions.json
```

`ref` is the holding name exactly as it appears in the review file. Anything not
listed is accepted unchanged. Every decision — accepted, edited, rejected —
is written to the ledger's acceptance log with your initials and a timestamp.

**A run can only be accepted once.** Re-running is refused, because accepting
twice would silently duplicate documents and inflate your cost figures. If you
genuinely need to redo one, `--reaccept` reverses the first acceptance and
applies it again.

### 3.4 Confirm instrument metadata

Write a file mapping instrument names to what they actually are:

```json
{
  "Sterling Park UK Equity Income OEIC Acc":
    { "type": "oeic", "domicile": "GB", "us_registered": false, "hmrc_reporting_fund": true },
  "Pioneer S&P Index Fund":
    { "type": "mutual_fund_us", "domicile": "US", "us_registered": true }
}
```

```sh
meridian review <run-id> --household <id> --accept-all \
        --confirm-metadata instruments.json --operator JS
```

Valid `type` values: `equity`, `bond`, `cash`, `oeic`, `ucits_etf`,
`investment_trust`, `mutual_fund_us`, `us_etf`, `mmf`, `other_pooled`,
`property`, `private_equity`.

`domicile` is the fund's country of domicile — **not** the ISIN prefix, which is
the issuing CSD and is often different.

### 3.5 Build the report

```sh
meridian report --household <id> --asof 2026-06-30 --html
```

Add:
- `--deck` — a paged version for screen-sharing
- `--benchmark global_equity_gbp=0.6,global_bonds_gbp=0.4` — a composite to
  measure against (weights must sum to 1; series are in
  `params/shared/benchmarks/`)
- `--narrate --api-key sk-…` — plain-English commentary. Every number in the
  generated text is checked against the computed results; a section that
  invents one is dropped rather than shown.
- `--offline` — refuses all network egress, on any command.

---

## 4. Why metadata confirmation matters

The PFIC analysis will not run on metadata the system merely guessed.

The parser can infer that "Atlas Global Equity UCITS ETF" is a UCITS ETF from
its name, and that an ISIN beginning `IE` suggests Ireland. Both inferences are
wrong often enough to matter — and being wrong here means telling a US person
that a fund is safe when it is a PFIC. So the cascade refuses to classify
anything you have not confirmed, and reports it as **needs classification**
instead.

'40 Act registration is the sharpest case: it is not knowable from a statement
at all. A US-domiciled fund with no confirmed registration stays unclassified —
it is not assumed safe just because it looks American.

If your report says "8 held instruments have unconfirmed metadata", that is why
the US section looks thin. Confirm them and re-run.

---

## 5. When a statement can't be parsed

It is parked in `parse-runs/failed/<run-id>/` with the original and the error.

```sh
meridian manual <run-id> --household <id>            # writes a template
```

The template is pre-filled only with what can be read without guessing — period
and currency, yes; institution, no. Fill it in from the document (there's a
redacted copy alongside it), then:

```sh
meridian manual <run-id> --household <id> --input filled.json
meridian review <new-run-id> --household <id> --accept-all --operator JS
```

Manual entry rejoins the ordinary review flow. It is a different way to produce
the extraction, not a way to skip acceptance, and the figures stay fingerprinted
against the original document.

---

## 6. Reading the report

Six sections, in the order a client asks:

1. **What you have** — total wealth in both currencies, then by account with
   how old each figure is, then by wrapper. The button top-right swaps which
   currency is primary.
2. **What it costs** — annual charges, in pounds and basis points, with what
   that compounds to over 20 years. Every charge is traced to its document.
3. **How it has done** — return, labelled by method. "Modified Dietz ·
   estimate" means exactly that; it is not presented as exact.
4. **What you are exposed to** — asset classes, largest positions,
   concentration above 5% of investable wealth, currency, wrapped vs unwrapped.
5. **What should worry you** — only if a household member is a US person.
   Opens with the count of critical flags. **Red appears nowhere in this report
   unless there is a critical flag**, so red always means something.
6. **Where every figure came from** — every source document, fingerprinted and
   dated. This section is the point: it is what makes the rest checkable.

**Read the warnings at the bottom.** They are not boilerplate. They tell you
when a figure excludes a snapshot that couldn't be valued, when performance
starts later than you'd expect, and when instruments are unclassified.

---

## 7. What it does not do

- No advice, no recommendations. It reports positions and flags exposure.
- No live prices or FX. Everything comes from statements you ingest.
- No look-through into funds, so currency and geographic exposure are measured
  by the quote currency and the fund's domicile, not its holdings.
- No CGT position, IHT calculation, allowance tracking or cashflow modelling.
- One operator, one machine. No accounts, no sharing, no multi-user.
- Transactions are optional; with only snapshots, returns are estimates.

## 8. When something goes wrong

| What you see | What it means |
|---|---|
| `could not be parsed — parked in parse-runs/failed/…` | The layout isn't recognised. Use `meridian manual` (§5). |
| `unrecognised proper noun "…"` | A name that isn't in your vault was found. Add it to `names`, or add a legitimate institution to `params/shared/redaction-vocabulary.json`. Nothing is transmitted until you do. |
| `refusing … conversion: nearest rate is N days old` | No FX rate close enough to the valuation date. Ingest a statement that quotes one, or add it to the ledger's `fx_rates`. |
| `run … was already accepted` | You accepted it before. Use `--reaccept` only if you mean to replace it. |
| `is a PDF and 'pdftotext' is not installed` | `brew install poppler`, or convert the file yourself. |
| `N held instruments have unconfirmed metadata` | Not an error. Confirm them (§4) to get the tax analysis. |

## 9. About the tax content

Several positions this tool reports depend on how the UK/US double tax treaty
is read, and qualified practitioners disagree about some of them. A treaty
position is an argument, not settled law: HMRC or the IRS may take a different
view, published guidance changes, and the outcome can turn on elections and
filings made years ago that this tool cannot see.

Every wrapper now shows what its position rests on, and any position sourced to
an analogy rather than authority is marked **"a treaty position, not settled
authority"** in the report. The SIPP treatment is the clearest example: it is a
treaty position, not a statutory exemption, and it depends on the scheme
qualifying.

**Nothing in this tool has been reviewed by a US-qualified tax adviser.**
Consulting a tax lawyer or dual-qualified adviser is strongly recommended
before acting on anything it reports — and particularly before assuming a
wrapper is safe because it is marked OK.

---

Analysis and information only. Not a personal recommendation. Not tax advice.
US tax outcomes depend on elections and filings not visible to this system.
Treaty interpretations differ — consult a tax lawyer.
