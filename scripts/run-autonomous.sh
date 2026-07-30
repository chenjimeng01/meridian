#!/usr/bin/env bash
# Meridian long-run driver. Usage: nohup ./scripts/run-autonomous.sh &
set -u
cd "$(dirname "$0")/.."
PROMPT='Read SPEC.md and PROGRESS.md. Continue from the recorded state.
Follow §10 phase gates and §12 agent policy exactly. Update PROGRESS.md
after every completed step. When Phase 6 acceptance passes and the final
structural review has zero MUST-FIX items, create DONE.md and stop.'

while [ ! -f DONE.md ]; do
  claude --continue --permission-mode acceptEdits -p "$PROMPT" \
    >> run.log 2>&1
  EXIT=$?
  if [ -f DONE.md ]; then break; fi
  if tail -n 40 run.log | grep -qiE "usage limit|rate.?limit|resets at"; then
    echo "$(date -Is) limit hit — sleeping 5h10m" >> run.log
    sleep 18600            # 5h + 10min buffer past the window reset
  else
    echo "$(date -Is) exited (code $EXIT) — brief backoff, resuming" >> run.log
    sleep 120              # crash/complete-turn backoff; harmless if work remains
  fi
done
echo "$(date -Is) DONE.md present — build complete" >> run.log
