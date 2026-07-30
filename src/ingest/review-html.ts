// Mobile-first review diff (SPEC §5.5): a self-contained HTML file the
// operator opens to accept/edit/reject a parse run line-by-line. Rendered from
// REDACTED data only — this file may be viewed on any device.
// Designed at 390×844 first; no external assets; SPEC §8 palette.
import type { Ledger, ParseRun } from "./types.ts";

const esc = (s: unknown) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const money = (m?: { amount: number; currency: string }) =>
  m ? `${m.currency === "USD" ? "$" : m.currency === "GBP" ? "£" : m.currency + " "}${m.amount.toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : "—";

const LOW_CONFIDENCE = 0.9;

export function renderReviewHtml(run: ParseRun, ledger: Ledger): string {
  const src = run.output.source;
  const matchFor = (ai: number, hi: number) =>
    run.matches.find((m) => m.accountIndex === ai && m.holdingIndex === hi);

  const sections = run.output.accounts
    .map((acct, ai) => {
      const account = ledger.accounts.find((a) => a.account_token === acct.account_token);
      const rows = (acct.holdings ?? [])
        .map((h, hi) => {
          const m = matchFor(ai, hi);
          let status = "new";
          let diff = "";
          if (m?.status === "matched" && account) {
            status = "update";
            const prior = ledger.holdings
              .filter((x) => x.account_id === account.id && x.instrument_id === m.instrumentId)
              .sort((a, b) => a.asof.localeCompare(b.asof))
              .at(-1);
            if (prior) diff = `<div class="prior">was ${esc(prior.units)} units · ${esc(money(prior.value))} (${esc(prior.asof)})</div>`;
          } else if (m?.status === "candidates") {
            status = "confirm match";
          }
          // An instrument whose classifying metadata the operator has not
          // confirmed cannot be assessed for PFIC status (SPEC §7.1) — the
          // review file is where that confirmation is asked for.
          const existing = m?.instrumentId
            ? ledger.instruments.find((i) => i.id === m.instrumentId)
            : undefined;
          const needsMetadata = !existing || existing.metadata_confirmed !== true;
          const low = h.confidence < LOW_CONFIDENCE;
          return `<li class="line${low ? " low" : ""}">
  <div class="name">${esc(h.name)}</div>
  <div class="figures">${esc(h.units)} units · ${esc(money(h.price))} · <strong>${esc(money(h.value))}</strong></div>
  ${diff}
  <div class="meta"><span class="chip ${status === "new" ? "chip-new" : "chip-ok"}">${status}</span>
  <span class="conf">confidence ${h.confidence.toFixed(2)}</span>
  ${needsMetadata ? '<span class="chip chip-new">confirm type &amp; domicile</span>' : ""}
  ${low ? '<span class="lownote">low confidence — page image unavailable (text ingest v0); check source document</span>' : ""}</div>
</li>`;
        })
        .join("\n");

      const cash = acct.cash_balance
        ? `<li class="line"><div class="name">Cash balance</div><div class="figures"><strong>${esc(money(acct.cash_balance))}</strong></div><div class="meta"><span class="chip chip-ok">update</span><span class="conf">confidence ${acct.cash_balance.confidence.toFixed(2)}</span></div></li>`
        : "";
      const fees = (acct.fees ?? [])
        .map((f) => `<li class="line"><div class="name">${esc(f.label)}</div><div class="figures">${esc(f.category)} · <strong>${esc(money(f.amount))}</strong>${f.rate_bps ? ` · ${esc(f.rate_bps)} bps` : ""}</div><div class="meta"><span class="chip chip-new">new</span><span class="conf">confidence ${f.confidence.toFixed(2)}</span></div></li>`)
        .join("\n");
      const moves = (acct.movements ?? [])
        .map((mv) => `<li class="line"><div class="name">${esc(mv.date)} · ${esc(mv.type)}</div><div class="figures">${esc(mv.description ?? "")} · <strong>${esc(money(mv.amount))}</strong></div><div class="meta"><span class="chip chip-new">new</span><span class="conf">confidence ${mv.confidence.toFixed(2)}</span></div></li>`)
        .join("\n");

      return `<section>
<h2>${esc(acct.account_token)} <span class="wrapper">${esc(acct.wrapper_hint ?? "unknown wrapper")}${account ? "" : " · new account"}</span></h2>
<ul>${rows}${cash}${fees}${moves}</ul>
</section>`;
    })
    .join("\n");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Review ${esc(run.id)}</title>
<style>
  :root { --paper:#FAFAF7; --ink:#101B2D; --soft:#47536B; --brass:#8C7A3F; --rule:#D9D6CC; }
  @media (prefers-color-scheme: dark) { :root { --paper:#0C1524; --ink:#EDEBE3; --soft:#9AA5BC; --brass:#B49B54; --rule:#243049; } }
  * { box-sizing:border-box; } body { margin:0; background:var(--paper); color:var(--ink);
    font:16px/1.5 Seravek,"Gill Sans",system-ui,sans-serif; }
  main { max-width:720px; margin:0 auto; padding:1rem 1rem 3rem; }
  h1 { font:500 1.25rem/1.3 "Iowan Old Style",Palatino,Georgia,serif; margin:0.5rem 0 0.25rem; }
  .src { color:var(--soft); font-size:0.8rem; }
  h2 { font:500 1.05rem "Iowan Old Style",Palatino,Georgia,serif; border-top:1px solid var(--rule);
    padding-top:1rem; margin:1.5rem 0 0.5rem; }
  .wrapper { color:var(--soft); font-size:0.75rem; text-transform:uppercase; letter-spacing:0.1em; }
  ul { list-style:none; margin:0; padding:0; }
  .line { border:1px solid var(--rule); padding:0.7rem 0.8rem; margin:0.5rem 0; }
  .line.low { border-color:var(--brass); }
  .name { font-weight:600; } .figures { font-variant-numeric:tabular-nums; }
  .prior { color:var(--soft); font-size:0.8rem; font-variant-numeric:tabular-nums; }
  .meta { display:flex; gap:0.6rem; align-items:center; flex-wrap:wrap; margin-top:0.35rem; font-size:0.75rem; }
  .chip { border:1px solid var(--rule); border-radius:999px; padding:0.05rem 0.55rem; min-height:24px; display:inline-flex; align-items:center; }
  .chip-new { border-color:var(--brass); color:var(--brass); }
  .conf { color:var(--soft); font-variant-numeric:tabular-nums; }
  .lownote { color:var(--brass); }
  footer { margin-top:2rem; color:var(--soft); font-size:0.72rem; border-top:1px solid var(--rule); padding-top:0.75rem; }
</style>
</head>
<body>
<main>
<h1>Parse review — ${esc(src.institution)}</h1>
<p class="src">${esc(src.doc_type)} · ${esc(src.period.from)} → ${esc(src.period.to)} · ${esc(run.filename)}<br>
run ${esc(run.id)} · overall confidence ${run.output.overall_confidence.toFixed(2)}</p>
${sections}
<footer>Redacted review file — tokens in place of names and account numbers. Only accepted lines enter the ledger.
Analysis and information only; not a personal recommendation; not tax advice.</footer>
</main>
</body>
</html>
`;
}
