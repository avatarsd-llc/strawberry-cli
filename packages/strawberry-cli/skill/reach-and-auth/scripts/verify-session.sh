#!/usr/bin/env bash
# verify-session.sh — confirm a reach-and-auth result: a resumable, authenticated session.
#
# Usage:
#   verify-session.sh <ws-host> <token-file>
#
#   <ws-host>     ws://<ip>/ws (or a bare host / host:port the CLI normalizes)
#   <token-file>  the 0600 token written by `strawberry auth login --token-file`
#
# Exit 0 = the stored token resumes AND a capabilities query succeeds.
# Exit non-zero = no working session (re-run `strawberry auth login`).
#
# Drives only strawberry-cli; does nothing destructive to the board (no reboot/NVS write).
set -euo pipefail

HOST="${1:?usage: verify-session.sh <ws-host> <token-file>}"
TOKEN_FILE="${2:?usage: verify-session.sh <ws-host> <token-file>}"

if ! command -v strawberry >/dev/null 2>&1; then
  echo "verify-session: 'strawberry' CLI not on PATH (provided by @avatarsd-llc/strawberry-cli)" >&2
  exit 127
fi

if [[ ! -f "$TOKEN_FILE" ]]; then
  echo "verify-session: token file '$TOKEN_FILE' not found — run 'strawberry auth login' first" >&2
  exit 2
fi

# Bearer credential: warn if the token file is not locked down to 0600.
perms="$(stat -c '%a' "$TOKEN_FILE" 2>/dev/null || stat -f '%Lp' "$TOKEN_FILE" 2>/dev/null || echo '?')"
if [[ "$perms" != "600" ]]; then
  echo "verify-session: WARNING token file mode is '$perms', expected 600 — run: chmod 600 '$TOKEN_FILE'" >&2
fi

echo "verify-session: resuming stored token against $HOST ..." >&2
strawberry auth resume --host "$HOST" --token-file "$TOKEN_FILE" --json

echo "verify-session: reading capabilities over the authenticated session ..." >&2
strawberry query capabilities --host "$HOST" --json

echo "verify-session: OK — session is authenticated and resumable." >&2
