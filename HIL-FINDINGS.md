# strawberry-cli — hardware-in-the-loop findings

HIL of `strawberry-cli` against a live Gorshok-v4 board (`10.5.60.177`, fw with the
ADR-0067 bindings fix + the Wi-Fi RX lever). Goal: exercise every command against
real hardware and drive test coverage to 100%. This is the running catalog.

## Verified working against the board

- `help` / `help --json` — full command tree.
- `info` — SEC-001 HMAC login + capabilities/system_flags/wifi, decoded correctly.
- `auth login` — HMAC challenge-response; writes a 0600 token file.
- `query <what>` for: `capabilities`, `wifi`, `device_config`, `grow_config`,
  `system_flags`, `time` — each returns its decoded state.
- `grow unit-list` — returns the live units.
- `controllers list` — returns the live controller graph.

## Bugs found (severity-ordered)

### B1 — `auth resume` / token persistence is non-functional (HIGH)
The firmware **binds each auth token to the socket that created it and revokes it on
socket close** (`ws_h_auth.c:98-101`, the S-30/PERF-034 8-slot-leak fix). So in the
CLI's per-process model — `auth login` opens a socket, logs in, then *closes* — the
token is revoked the instant the login command exits. `auth resume` (a new process,
new socket) then sends the stored token and the firmware answers `419 token expired`
(slot not found). Verified end-to-end (`STRAWBERRY_DEBUG=1`: correct token on the
wire, `error{code:419, detail:"token expired"}`).
- **Consequence:** token-file persistence + `auth resume` can never work across CLI
  invocations on this firmware; the `reach-and-auth` skill's "persist the token …
  resume across reboots" premise is **false**.
- **Fix options:** (a) drop `auth resume` + token-file persistence from the CLI; every
  command already logs in fresh (works). (b) Keep the token only within a single
  long-lived process/connection and document that. (c) Firmware change: a persistent
  (non-socket-bound) token class — but that re-opens the leak the fix closed. Recommend
  (a) + correct the skill.

### B2 — `diag heap` (and `query stats`/`snapshot`) assume queryable push-only state (HIGH)
`diag heap` does a one-shot `query(WHAT_STATS)` (`diag.ts:32`), but the firmware
returns `unknown query` for `WHAT_STATS` — **stats is push-only** (`TOPIC_STATS`).
`query snapshot` likewise returns an `ack`, not a `SensorSnapshot` (push-only). So
`diag heap` fails with "stats query returned no Stats".
- **Fix:** `diag heap`/`stress` must **subscribe** to `TOPIC_STATS` for `--seconds`
  and fold the frames (as `tools/ws_heap_probe.py` does), not query. Drop `stats`/
  `snapshot` from the `query` verb list (or make them transparently subscribe-once).

### B3 — `discover` command missing (HIGH)
`reach-and-auth` Step 1 documents `strawberry discover --cidr … --mac …`, but the CLI
has no `discover` command (`unknown command 'discover'`). The Map phase designed it;
the CLI builder never implemented it.
- **Fix:** implement `discover` (WS-probe a CIDR, confirm by MAC via `Capabilities`/
  `WifiState`), or descope it from the skill and connect by `--host` directly.

### B4 — bin name mismatch (MED) — FIXED
Skills invoke `strawberry`; the package only registered `strawberry-cli`. Added
`strawberry` as a bin alias (both now resolve).

### B5 — password env var mismatch (LOW)
`help`/`--help` advertise `STRAWBERRY_PW`; the `reach-and-auth` skill uses
`STRAWBERRY_PASSWORD`. Pick one (support both, or align docs+code).

### B6 — `bootOffsetMs` = raw `Date.now()` (LOW)
`adoptAuthOk` computes `Date.now() - Number(ok.serverNowMs)`, but the firmware sends
`serverNowMs == 0`, so the offset is wall-clock garbage. Either the firmware should
populate `server_now_ms` or the CLI should stop deriving an offset from it.

## Test-coverage status

- Current suite: **28 mock-based vitest tests** (`tsc` clean, `tsup` builds).
- Coverage tooling not yet wired: `@vitest/coverage-v8` is absent (add it +
  `coverage` config; needs network).
- **Key lesson:** 100% *line* coverage of mock-based tests would still have missed
  B1/B2 — they are firmware-reality mismatches. "100% test cases" must include a
  **HIL acceptance matrix** (one row per command, run against a real board) on top of
  unit coverage.

## Plan to "100% coverage"

1. Fix B1-B3, B5-B6 (B4 done). Re-HIL each.
2. Add `@vitest/coverage-v8` + a coverage gate; raise unit coverage to 100% line/branch.
3. Author a HIL acceptance matrix script (`scripts/hil-matrix.mjs`): one assertion per
   command against `--host`, safe/read-only by default, with an opt-in `--mutating`
   tier (throwaway unit + cleanup) for `grow`/`controllers`/`system`, and dry-run-only
   for `ota`/`reboot`/`net wifi`.
4. Wire both into the package's test script; the HIL matrix is the source of truth for
   "covers 100% of cases against real hardware".
