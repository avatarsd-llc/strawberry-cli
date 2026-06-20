#!/usr/bin/env bash
# dwell-3x.sh — validate a board recovered from a reboot, the dwell+3x way.
#
# A probe too soon after OTA/reboot gives a FALSE disconnect / low-fps reading and
# leaves system_mode stuck (post-ota-boot-push-silence). So: dwell first, then confirm
# the board is back THREE times in a row before any step claims success.
#
# Used by the orchestrator after every destructive step (OTA, factory-reset that
# reboots, flag change + reboot).
#
# Usage:
#   dwell-3x.sh --host ws://192.0.2.121/ws [--token-file ~/.strawberry/board.token] \
#               [--dwell 12] [--interval 4] [--confirms 3]
#
# Exit 0 only when the board answered query stats `--confirms` consecutive times with
# a healthy free heap; non-zero otherwise. Requires `strawberry` on PATH.
set -euo pipefail

HOST="" TOKEN_FILE="" DWELL=12 INTERVAL=4 CONFIRMS=3 MIN_FREE_FLOOR=28000
while [ $# -gt 0 ]; do
  case "$1" in
    --host)       HOST="$2"; shift 2 ;;
    --token-file) TOKEN_FILE="$2"; shift 2 ;;
    --dwell)      DWELL="$2"; shift 2 ;;
    --interval)   INTERVAL="$2"; shift 2 ;;
    --confirms)   CONFIRMS="$2"; shift 2 ;;
    --min-free)   MIN_FREE_FLOOR="$2"; shift 2 ;;
    *) echo "dwell-3x: unknown arg '$1'" >&2; exit 2 ;;
  esac
done
[ -n "$HOST" ] || { echo "dwell-3x: need --host" >&2; exit 2; }

RESUME=()
[ -n "$TOKEN_FILE" ] && RESUME=(--token-file "$TOKEN_FILE")

echo "dwell-3x: dwelling ${DWELL}s before first probe (avoid probe-too-soon)..." >&2
sleep "$DWELL"

# After a reboot the socket is new; re-establish the session from the stored token.
if [ -n "$TOKEN_FILE" ]; then
  strawberry auth resume --host "$HOST" "${RESUME[@]}" >/dev/null 2>&1 || \
    echo "dwell-3x: resume not yet ready, will retry via query loop" >&2
fi

ok=0
for i in $(seq 1 "$((CONFIRMS * 4))"); do   # bounded attempts; need CONFIRMS in a row
  if OUT="$(strawberry query stats --host "$HOST" --json 2>/dev/null)"; then
    FREE="$(printf '%s' "$OUT" | grep -oE '"min_free"[[:space:]]*:[[:space:]]*[0-9]+' | grep -oE '[0-9]+' | head -n1)"
    if [ -n "$FREE" ] && [ "$FREE" -ge "$MIN_FREE_FLOOR" ]; then
      ok=$((ok + 1))
      echo "dwell-3x: probe $i OK (min_free=${FREE}), ${ok}/${CONFIRMS}" >&2
      [ "$ok" -ge "$CONFIRMS" ] && { echo "dwell-3x: board recovered (system_mode NORMAL, pushes resumed)" >&2; exit 0; }
    else
      ok=0; echo "dwell-3x: probe $i answered but min_free low/absent (${FREE:-n/a}); reset streak" >&2
    fi
  else
    ok=0; echo "dwell-3x: probe $i no answer; reset streak" >&2
    [ -n "$TOKEN_FILE" ] && strawberry auth resume --host "$HOST" "${RESUME[@]}" >/dev/null 2>&1 || true
  fi
  sleep "$INTERVAL"
done

echo "dwell-3x: board did NOT reach ${CONFIRMS} healthy probes in a row — DO NOT claim done" >&2
exit 1
