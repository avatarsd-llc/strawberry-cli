#!/usr/bin/env bash
#
# validate-dwell-3x.sh — post-OTA recovery gate for the flash-ota skill.
#
# After a reboot-causing OTA (--bin / --combined), a probe issued too soon reads
# as a FALSE disconnect / "pushes silent": while the device is mid-reboot,
# web_is_ota_active() keeps push streams silent. The only honest proof the board
# recovered is that the Stats push stream resumes (== system_mode back to NORMAL)
# AND it stays that way across repeated reads. This script dwells, optionally
# re-resolves the board by MAC (DHCP drifts), re-auths the stored token, then
# requires THREE spaced passes of: ota not-in-progress + a live/healthy heap.
#
# It is a thin wrapper over `strawberry`; it never touches the wire itself.
# Exit 0 only if all three passes succeed; non-zero otherwise.
#
# Usage:
#   validate-dwell-3x.sh --host ws://<ip>/ws --token-file <t> \
#       [--mac <board-mac> --cidr <lan-cidr>] \
#       [--dwell 15] [--min-free 28000] [--strawberry strawberry]
#
set -euo pipefail

HOST=""
TOKEN_FILE=""
MAC=""
CIDR=""
DWELL=15
MIN_FREE=28000
HEAP_SECONDS=10
STRAWBERRY="${STRAWBERRY_BIN:-strawberry}"

die() { echo "validate-dwell-3x: $*" >&2; exit 2; }

usage() {
    sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'
    exit 0
}

while [ $# -gt 0 ]; do
    case "$1" in
        --host)        HOST="$2"; shift 2 ;;
        --token-file)  TOKEN_FILE="$2"; shift 2 ;;
        --mac)         MAC="$2"; shift 2 ;;
        --cidr)        CIDR="$2"; shift 2 ;;
        --dwell)       DWELL="$2"; shift 2 ;;
        --min-free)    MIN_FREE="$2"; shift 2 ;;
        --heap-seconds) HEAP_SECONDS="$2"; shift 2 ;;
        --strawberry)  STRAWBERRY="$2"; shift 2 ;;
        -h|--help)     usage ;;
        *)             die "unknown arg: $1 (try --help)" ;;
    esac
done

[ -n "$HOST" ]       || die "--host is required"
[ -n "$TOKEN_FILE" ] || die "--token-file is required"
command -v "$STRAWBERRY" >/dev/null 2>&1 || die "'$STRAWBERRY' not on PATH (set --strawberry or \$STRAWBERRY_BIN)"

# A JSON value extractor that prefers jq but degrades to grep so the script runs
# on a bare box. $1 = json, $2 = key name.
json_field() {
    local json="$1" key="$2"
    if command -v jq >/dev/null 2>&1; then
        printf '%s' "$json" | jq -r --arg k "$key" '
            ($k|split(".")) as $p
            | getpath($p) // (.. | objects | select(has($k)) | .[$k])
            | select(. != null)' 2>/dev/null | head -n1
    else
        # crude fallback: first "key": value (number, bool, or quoted string)
        printf '%s' "$json" \
            | grep -oE "\"$key\"[[:space:]]*:[[:space:]]*(\"[^\"]*\"|[-0-9.]+|true|false)" \
            | head -n1 | sed -E "s/.*:[[:space:]]*//; s/^\"//; s/\"$//"
    fi
}

echo "==> dwell ${DWELL}s for the reboot to land and tasks to settle"
sleep "$DWELL"

# Optional: re-resolve by MAC in case DHCP moved the board after the reboot.
if [ -n "$MAC" ]; then
    echo "==> re-resolving board by MAC ${MAC}${CIDR:+ on ${CIDR}}"
    DISCO="$("$STRAWBERRY" discover ${CIDR:+--cidr "$CIDR"} --mac "$MAC" --json || true)"
    NEW_IP="$(json_field "$DISCO" ip || true)"
    if [ -n "$NEW_IP" ]; then
        case "$NEW_IP" in
            ws://*|wss://*) HOST="$NEW_IP" ;;
            *)              HOST="ws://${NEW_IP}/ws" ;;
        esac
        echo "    -> board at ${HOST}"
    else
        echo "    !! MAC not found yet; keeping ${HOST} (board may still be booting)" >&2
    fi
fi

# Re-authenticate with the stored token — the pre-OTA socket is gone.
echo "==> resuming session from token"
"$STRAWBERRY" auth resume --host "$HOST" --token-file "$TOKEN_FILE" --json \
    || die "auth resume failed — token invalid/expired or board not back yet"

PASSES=3
GAP=5
for i in $(seq 1 "$PASSES"); do
    echo "==> recovery check ${i}/${PASSES}"

    OTA_JSON="$("$STRAWBERRY" query ota --host "$HOST" --json)" \
        || die "pass ${i}: 'query ota' failed (board not serving yet)"
    IN_PROGRESS="$(json_field "$OTA_JSON" in_progress || true)"
    if [ "$IN_PROGRESS" = "true" ]; then
        die "pass ${i}: OTA still in_progress — boot not complete"
    fi

    HEAP_JSON="$("$STRAWBERRY" diag heap --host "$HOST" --seconds "$HEAP_SECONDS" --json)" \
        || die "pass ${i}: 'diag heap' failed (no Stats push stream == pushes still silent)"
    MF="$(json_field "$HEAP_JSON" min_free || true)"
    if [ -z "$MF" ]; then
        die "pass ${i}: no min_free in diag heap output (Stats stream not flowing)"
    fi
    if [ "$MF" -lt "$MIN_FREE" ] 2>/dev/null; then
        die "pass ${i}: min_free ${MF} < floor ${MIN_FREE} — heap regression"
    fi
    echo "    ok: in_progress=false, min_free=${MF} (>= ${MIN_FREE})"

    [ "$i" -lt "$PASSES" ] && sleep "$GAP"
done

echo "==> dwell+3x PASS: board recovered at ${HOST} (system_mode NORMAL, pushes resumed, heap healthy)"
