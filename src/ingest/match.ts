// Instrument matching (SPEC §5.4): deterministic on ISIN/SEDOL/CUSIP first;
// otherwise fuzzy name match PROPOSES candidates — it never auto-accepts.
// Unmatched holdings become new draft instruments flagged needs_review.
import type { Ledger, MatchResult, ParseOutput } from "./types.ts";

const STOPWORDS = new Set([
  "fund", "etf", "ucits", "oeic", "acc", "inc", "plc", "ordinary", "common",
  "stock", "shares", "class", "the", "trust", "index",
]);

function nameTokens(name: string): Set<string> {
  return new Set(
    name
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((t) => t.length > 1 && !STOPWORDS.has(t))
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

const FUZZY_THRESHOLD = 0.6;

export function matchInstruments(output: ParseOutput, ledger: Ledger): MatchResult[] {
  const results: MatchResult[] = [];
  output.accounts.forEach((acct, accountIndex) => {
    (acct.holdings ?? []).forEach((holding, holdingIndex) => {
      const ids = holding.identifiers ?? {};
      const exact = ledger.instruments.find(
        (inst) =>
          (ids.isin && inst.identifiers.isin === ids.isin) ||
          (ids.sedol && inst.identifiers.sedol === ids.sedol) ||
          (ids.cusip && inst.identifiers.cusip === ids.cusip)
      );
      if (exact) {
        results.push({ accountIndex, holdingIndex, status: "matched", instrumentId: exact.id });
        return;
      }
      const tokens = nameTokens(holding.name);
      const scored = ledger.instruments
        .filter((inst) => inst.type !== "cash")
        .map((inst) => ({ id: inst.id as string, score: jaccard(tokens, nameTokens(inst.name)) }))
        .filter((s) => s.score >= FUZZY_THRESHOLD)
        .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
      if (scored.length) {
        results.push({ accountIndex, holdingIndex, status: "candidates", candidates: scored.map((s) => s.id) });
      } else {
        results.push({ accountIndex, holdingIndex, status: "new" });
      }
    });
  });
  return results;
}
