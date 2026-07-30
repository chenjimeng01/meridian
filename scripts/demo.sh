#!/usr/bin/env bash
# Meridian end-to-end demo (SPEC §10 Phase 6: "demo script runs both households
# start-to-finish"). Builds two households from the synthetic fixtures and
# opens the client report.
#
#   ./scripts/demo.sh            build both households and open the report
#   ./scripts/demo.sh --serve    also serve them over http so the PWA and the
#                                service-worker-free offline path behave as
#                                they would in production
#
# Everything here is synthetic (see NOTICE). No network egress: ingestion runs
# on the deterministic extractor, and nothing is sent anywhere.
set -euo pipefail
cd "$(dirname "$0")/.."

DATA_ROOT="${MERIDIAN_DATA_ROOT:-./demo-data}"
ASOF="2026-06-30"
PORT="${MERIDIAN_PORT:-8787}"
SERVE=false
[ "${1:-}" = "--serve" ] && SERVE=true

meridian() { node --import tsx src/cli/main.ts "$@"; }

say() { printf '\n\033[1m%s\033[0m\n' "$1"; }

rm -rf "$DATA_ROOT"

# --- Household 1: the US-connected household -------------------------------
say "1/4  Creating the US-connected household"
meridian households create --config test/fixtures/household-config.json --data-root "$DATA_ROOT" >/dev/null
USUK=$(meridian households list --data-root "$DATA_ROOT" | head -1 | awk '{print $1}')
echo "     household $USUK"

say "2/4  Ingesting 15 statements from 5 institutions"
for statement in test/fixtures/statements/*/*.txt; do
  meridian ingest "$statement" --household "$USUK" --data-root "$DATA_ROOT" >/dev/null
  printf '.'
done
echo ""
echo "     each run wrote a redacted review file to parse-runs/<run-id>/review.html"

say "3/4  Accepting each parse, confirming instrument metadata"
for run in $(ls "$DATA_ROOT/$USUK/parse-runs" | grep -v failed); do
  meridian review "$run" --household "$USUK" --data-root "$DATA_ROOT" \
    --accept-all --confirm-metadata test/fixtures/instrument-metadata.json --operator JC >/dev/null
  printf '.'
done
echo ""
echo "     confirming type and domicile is what unlocks the PFIC analysis"

say "4/4  Building the report"
meridian report --household "$USUK" --asof "$ASOF" --data-root "$DATA_ROOT" \
  --html --deck --benchmark global_equity_gbp=0.6,global_bonds_gbp=0.4

REPORT="$DATA_ROOT/$USUK/reports/report-$ASOF.html"

# --- Household 2: UK-only, to show the US module vanish --------------------
say "Also building a UK-only household — the US section should be absent"
UK_CONFIG="$DATA_ROOT/uk-only-config.json"
mkdir -p "$DATA_ROOT"
node -e '
const fs = require("fs");
const base = JSON.parse(fs.readFileSync("test/fixtures/household-config.json", "utf8"));
// One UK-only person; same accounts, so the only difference is the tax profile.
const uk = {
  ...base,
  comment: "SYNTHETIC. A UK-only household: SPEC §7 requires the US module to be absent, not empty.",
  persons: [{ ...base.persons[1], token: "P1" }],
  account_owners: Object.fromEntries(Object.keys(base.account_owners).map((k) => [k, ["P1"]])),
};
fs.writeFileSync(process.argv[1], JSON.stringify(uk, null, 2));
' "$UK_CONFIG"

meridian households create --config "$UK_CONFIG" --data-root "$DATA_ROOT" >/dev/null
UKONLY=$(meridian households list --data-root "$DATA_ROOT" | grep -v "$USUK" | head -1 | awk '{print $1}')
for statement in test/fixtures/statements/*/*.txt; do
  meridian ingest "$statement" --household "$UKONLY" --data-root "$DATA_ROOT" >/dev/null
done
for run in $(ls "$DATA_ROOT/$UKONLY/parse-runs" | grep -v failed); do
  meridian review "$run" --household "$UKONLY" --data-root "$DATA_ROOT" --accept-all --operator JC >/dev/null
done
meridian report --household "$UKONLY" --asof "$ASOF" --data-root "$DATA_ROOT" --html

say "Done"
cat <<SUMMARY
US-connected report : $REPORT
Screen-share deck   : $DATA_ROOT/$USUK/reports/deck-$ASOF.html
UK-only report      : $DATA_ROOT/$UKONLY/reports/report-$ASOF.html
A review screen     : $(ls -d "$DATA_ROOT/$USUK"/parse-runs/*/ | head -1)review.html

Everything is synthetic. No data left this machine.
SUMMARY

if [ "$SERVE" = true ]; then
  say "Serving on http://localhost:$PORT — Ctrl-C to stop"
  echo "  report: http://localhost:$PORT/$USUK/reports/report-$ASOF.html"
  echo "  deck:   http://localhost:$PORT/$USUK/reports/deck-$ASOF.html"
  ( cd "$DATA_ROOT" && python3 -m http.server "$PORT" )
else
  command -v open >/dev/null && open "$REPORT" || echo "Open $REPORT in a browser."
fi
