// SPEC §7.2 — wrapper-conflict map. One row per distinct wrapper the household
// holds, read straight out of params/shared/wrapper-matrix.json.
import type { WrapperMatrix } from "./params.ts";
import type { Position, Wrapper } from "./ledger-view.ts";
import { SEVERITIES, type WrapperConflict } from "./types.ts";

/** Most severe first, then alphabetical — deterministic and report-ready. */
function compare(a: WrapperConflict, b: WrapperConflict): number {
  const rank = SEVERITIES.indexOf(b.severity) - SEVERITIES.indexOf(a.severity);
  return rank !== 0 ? rank : a.wrapper.localeCompare(b.wrapper);
}

export function buildWrapperConflicts(
  wrappers: Wrapper[],
  positions: Position[],
  matrix: WrapperMatrix
): WrapperConflict[] {
  const valueByWrapper = new Map<string, number>();
  for (const p of positions) {
    valueByWrapper.set(p.wrapper, (valueByWrapper.get(p.wrapper) ?? 0) + p.valueBase);
  }

  return wrappers
    .map((w) => {
      const usCell = matrix.cell(w.wrapper, "us_person");
      const ukCell = matrix.cell(w.wrapper, "uk_resident");
      return {
        wrapper: w.wrapper,
        wrapperJurisdiction: w.wrapperJurisdiction,
        accountTokens: w.accountTokens,
        valueBase: valueByWrapper.get(w.wrapper) ?? 0,
        severity: usCell.severity,
        explanation: usCell.explanation,
        sources: usCell.sources,
        ukResident: ukCell,
      };
    })
    .sort(compare);
}
