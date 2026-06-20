#!/usr/bin/env bash
# resolve-host.sh — resolve a Gorshok-v4 board's current ws://<ip>/ws by MAC.
#
# DHCP leases drift, so a stale IP looks like a crash but isn't (device-hil-facts).
# Every later orchestration step takes $HOST from here, and re-runs this after any
# step that can move the lease (Wi-Fi join, reboot, OTA).
#
# Usage:
#   resolve-host.sh --cidr 192.0.2.0/24 --mac aa:bb:cc:dd:ee:ff   # discover by MAC
#   resolve-host.sh --host 192.0.2.121                            # trust a known IP
#
# Prints the ws URL (ws://<ip>/ws) to stdout on success; nothing + non-zero on failure.
# Requires the `strawberry` CLI on PATH (provided by @avatarsd-llc/strawberry-cli).
set -euo pipefail

CIDR="" MAC="" HOST=""
while [ $# -gt 0 ]; do
  case "$1" in
    --cidr) CIDR="$2"; shift 2 ;;
    --mac)  MAC="$2";  shift 2 ;;
    --host) HOST="$2"; shift 2 ;;
    *) echo "resolve-host: unknown arg '$1'" >&2; exit 2 ;;
  esac
done

# A bare host short-circuits discovery: normalize to a ws URL the CLI accepts
# (DeviceClient.forWsHost takes bare host, host:port, or full ws(s):// URL).
if [ -n "$HOST" ]; then
  case "$HOST" in
    ws://*|wss://*) echo "$HOST" ;;
    *)              echo "ws://${HOST}/ws" ;;
  esac
  exit 0
fi

[ -n "$CIDR" ] || { echo "resolve-host: need --cidr or --host" >&2; exit 2; }
[ -n "$MAC"  ] || { echo "resolve-host: need --mac to confirm the board (DHCP drifts)" >&2; exit 2; }

# WS-probe candidates (firmware ships no mDNS) and confirm by MAC. --json so the
# skill, not a human, parses the row. We do NOT pipe through jq (keep deps zero):
# strawberry's own --mac filter returns only the matching candidate.
OUT="$(strawberry discover --cidr "$CIDR" --mac "$MAC" --json)" || {
  echo "resolve-host: discover failed for $CIDR / $MAC" >&2; exit 1; }

# Expect exactly one candidate. The CLI prints one JSON object/array; pull the ip.
# Grep is sufficient and dependency-free for the single-match case.
IP="$(printf '%s' "$OUT" | grep -oE '"ip"[[:space:]]*:[[:space:]]*"[0-9.]+"' | grep -oE '[0-9.]+' | head -n1)"
[ -n "$IP" ] || { echo "resolve-host: no board matched MAC $MAC on $CIDR" >&2; echo "$OUT" >&2; exit 1; }

echo "ws://${IP}/ws"
