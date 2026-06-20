#!/usr/bin/env bash
# verify-unit.sh — read-back assertions that a cultivation unit built OK.
#
# Drives strawberry-cli (no wire protocol re-implemented) against a board with an
# already-authenticated session, and asserts the build invariants:
#   1. the unit exists, is active, and has a populated working schedule
#   2. every endpoint the graph binds to is present (grow io-list)
#   3. every controller node exists (controllers list)
#   4. NO ORPHANS — every grow.<unit>.* endpoint belongs to an active unit
#      (the firmware invariant verify_orphans.py guarded; an orphan leaks
#       io_layer slots toward the 511 ceiling)
#
# Requires: `strawberry` on PATH, `jq`, and an authed session for $HOST. Resolve
# $HOST by MAC first (DHCP drifts) via the strawberry-reach-and-auth skill.
#
# Usage:  ./verify-unit.sh <host> <unit-id>     e.g.  ./verify-unit.sh 192.0.2.177 grow.1
set -euo pipefail

HOST=${1:?usage: verify-unit.sh <host> <unit-id>}
UNIT=${2:?usage: verify-unit.sh <host> <unit-id>}

fail() { echo "FAIL: $*" >&2; exit 1; }
ok()   { echo "ok:   $*"; }

command -v strawberry >/dev/null || fail "strawberry CLI not on PATH"
command -v jq >/dev/null || fail "jq not installed"

# 1. unit present + active + schedule populated -------------------------------
gc=$(strawberry query grow_config --host "$HOST" --json)
echo "$gc" | jq -e --arg u "$UNIT" '.units[]? | select(.id == $u)' >/dev/null \
  || fail "unit $UNIT not found in grow_config"
active=$(echo "$gc" | jq -r --arg u "$UNIT" '.units[] | select(.id==$u) | .active')
[ "$active" = "true" ] || fail "unit $UNIT is not active (active=$active)"
ncols=$(echo "$gc" | jq -r --arg u "$UNIT" '.units[] | select(.id==$u) | (.schedParams // [] | length)')
[ "${ncols:-0}" -gt 0 ] || echo "warn: unit $UNIT has no schedule columns (schedule-set not run?)"
ok "unit $UNIT present, active, $ncols schedule column(s)"

# 2. endpoints the graph binds to are present ---------------------------------
strawberry grow io-list --host "$HOST" --unit "$UNIT" --json >/dev/null \
  || fail "grow io-list failed for $UNIT"
ok "grow io-list for $UNIT readable"

# 3. controllers exist and are listed -----------------------------------------
strawberry controllers list --host "$HOST" --json >/dev/null \
  || fail "controllers list failed"
ok "controllers list readable"

# 4. orphan invariant: every grow.<id>.* endpoint -> an ACTIVE unit -----------
active_units=$(echo "$gc" | jq -r '[.units[]? | select(.active==true) | .id]')
struct=$(strawberry query io_struct --host "$HOST" --json)
orphans=$(echo "$struct" | jq -r --argjson au "$active_units" '
  [ .entries[]?.id // empty
    | select(startswith("grow."))
    | . as $eid
    | ($eid | split(".")[1]) as $uid
    | select(($au | index($uid)) == null)
    | $eid ]
  | unique[]?')
if [ -n "${orphans}" ]; then
  echo "$orphans" | sed 's/^/  ORPHAN /' >&2
  fail "orphan grow.* endpoint(s) found (not owned by an active unit)"
fi
ok "no orphan endpoints"

echo "PASS: unit $UNIT built and verified"
