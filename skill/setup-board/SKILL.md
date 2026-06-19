---
name: setup-board
description: >
  Top-level orchestrator that takes an ARBITRARY Gorshok-v4 board from fresh to
  running+configured by sequencing the per-step skills in order: discover ->
  reach-and-auth -> capabilities -> provision-network -> wireguard -> flash-ota ->
  config-hardware -> build-grow-unit -> diagnose. Locates the board by MAC because
  DHCP drifts, drives each sub-skill via strawberry-cli, and stops for human sign-off
  before destructive steps (factory-reset, grow-erase, OTA). Use when asked to "set up
  a board", "bring up a Gorshok board", "provision and flash a board from scratch", or
  to run the full board bring-up.
---

# setup-board — fresh board to running, orchestrated

This is the **orchestrator**. It does not implement board operations itself; it sequences the
per-step skills, each of which drives `strawberry-cli`. The CLI is a thin front end over the
shared `@avatarsd-llc/device-client` library (the one WS+protobuf core, ADR-0066).

## Contract

- **Input:** how to reach the board (a known IP, a `--cidr` to scan, and/or a `--mac` to confirm),
  and the board's password (printed label, password file, or `$STRAWBERRY_PASSWORD`).
- **Output:** an authenticated, network-joined, flashed board with at least one verified
  cultivation unit, and a diagnose pass on record.
- **Non-negotiables:**
  - Locate the board **by MAC** (e.g. `e4:b3:23:90:ab:48`) — DHCP leases drift; a stale IP looks
    like a crash but isn't.
  - The firmware ships **no mDNS** — discovery is WS-probing candidate IPs.
  - **SEC-001** login only — the plaintext password never crosses the wire.
  - **Stop for human sign-off** before any destructive step (factory-reset, grow-erase, OTA).
  - After any reboot, validate **dwell+3x** (reboot landed, `system_mode=NORMAL`, pushes resumed),
    never a probe-too-soon read.
  - Keep WS clients **<= 2** (the C6 httpd wedges with more).

## Before you start: learn the vocabulary, don't guess it

The CLI command tree is generated from the library's live protobuf enums. Read it first so every
later step uses the board's *provable* vocabulary:

```bash
strawberry help --json
```

Never hard-code command/flag names from memory — take them from `help --json`.

## Helper scripts (in this skill dir)

Two thin, dependency-free `bash` helpers operationalize the parts of orchestration that are easy
to get wrong. They wrap `strawberry`; they add no protocol logic of their own.

- `scripts/resolve-host.sh` — resolve the board's **current** `ws://<ip>/ws` by MAC. Run it in
  step 0, and **re-run it after any step that can move the DHCP lease** (Wi-Fi join in step 3, the
  reboot in step 5, the OTA reboot in step 6). A stale `$HOST` is the most common false "crash".
  ```bash
  HOST="$(skills/setup-board/scripts/resolve-host.sh --cidr 10.5.60.0/24 --mac e4:b3:23:90:ab:48)"
  # or trust a known IP: HOST="$(skills/setup-board/scripts/resolve-host.sh --host 10.5.60.121)"
  ```
- `scripts/dwell-3x.sh` — the reboot-recovery gate. Dwells, then requires the board to answer
  `query stats` with a healthy `min_free` **three times in a row** before any destructive step
  claims success. Call it after the reboot in step 5 and after the OTA in step 6.
  ```bash
  skills/setup-board/scripts/dwell-3x.sh --host "$HOST" --token-file "$TOKEN" --dwell 12
  ```

## Worked example (full bring-up)

```bash
# Operator-supplied facts for this run:
CIDR=10.5.60.0/24
MAC=e4:b3:23:90:ab:48
PWFILE=~/.strawberry/board.pw          # printed-label password, mode 0600
TOKEN=~/.strawberry/board.token        # FileTokenStore, written 0600 by the CLI
S=Skybox  ;  P='wifi-secret'           # operator Wi-Fi
WG=~/fleet/gorshok-ab48.conf           # wg-quick conf (fleet boards only)
IMG=~/builds/strawberry-fw-combined.img

strawberry help --json >/dev/null                                   # vocabulary is provable
HOST="$(skills/setup-board/scripts/resolve-host.sh --cidr "$CIDR" --mac "$MAC")"   # step 0
strawberry auth login --host "$HOST" --password-file "$PWFILE" --token-file "$TOKEN" --json  # step 1
strawberry query capabilities --host "$HOST" --json                 # step 2 (gate later steps)
# ... steps 3-8 below, re-resolving $HOST after every lease-moving step ...
```

Each numbered step lists the per-step skill to apply; defer the field detail (flag meanings, JSON
shapes, poll loops) to that sub-skill.

## Steps

Run these in order. Each bullet names the per-step skill to apply and the gate to clear before
moving on. The matching skills live in sibling directories under `skills/`.

### 0. Discover — find the board (skill: `reach-and-auth`)

```bash
strawberry discover --cidr <lan-cidr> --mac <board-mac> --json
HOST="$(skills/setup-board/scripts/resolve-host.sh --cidr <lan-cidr> --mac <board-mac>)"
```

WS-probes candidate IPs (no mDNS), opens each, reads `WHAT_CAPABILITIES` + `WifiState`, and
reports `ip/mac/board_rev`. Confirm the row whose MAC matches the target; that `ws://<ip>/ws` is
`$HOST` for everything below (the helper prints exactly that). If the board is fresh and only in
SoftAP, join its AP first (the ADR-0060 QR claim handshake is **design-only**, not yet on
firmware) and resolve with `--host <softap-ip>`.

**Gate:** exactly one candidate confirmed by MAC; `$HOST` set.

### 1. Authenticate (skill: `reach-and-auth`)

```bash
strawberry auth login --host $HOST --password-file <f> --token-file <t> --json
```

SEC-001 HMAC challenge-response (`AuthChallengeReq` -> `AuthChallenge{nonce}` ->
`HMAC-SHA256(password, nonce)` -> `AuthLogin{hmac}` -> `AuthOk{token}`). Persist the token to a
**0600** `--token-file`, so the reboots that OTA and flag changes cause can be ridden out with
`strawberry auth resume`.

**Gate:** `AuthOk` received; token file written with mode 0600.

### 2. Capabilities — gate every later step to the real hardware (skill: `reach-and-auth`)

```bash
strawberry query capabilities --host $HOST --json
strawberry query system_flags --host $HOST --json
strawberry query device_config --host $HOST --json
```

Learn `board_rev`, display kind, and zigbee/modbus/sd/flow/analog presence plus current subsystem
enables. Carry this forward: skip any later sub-step whose hardware the board lacks.

**Gate:** capabilities snapshot recorded; later steps scoped to it.

### 3. Network — join the LAN (skill: `provision-network`)

```bash
strawberry net wifi --host $HOST --ssid <S> --wifi-pass <P>
strawberry query wifi --host $HOST --json      # poll until connected with a LAN IP
strawberry net ha --host $HOST --enabled --mqtt-uri <U> [...]   # optional HA auto-discovery
```

If the board moves off SoftAP, its DHCP IP changes — **re-discover / re-resolve by MAC** and
update `$HOST`. Resume the session with the stored token.

**Gate:** `WifiState` shows connected with a routable LAN IP.

### 4. Overlay — fleet join (skill: `provision-network`, fleet only)

```bash
strawberry wg apply --host $HOST --conf <wg-quick.conf>
strawberry wg status --host $HOST --watch 60   # until peer == up
```

Parses `[Interface]`/`[Peer]`, derives the on-link netmask from the `AllowedIPs` subnet. Skip for
standalone boards.

**Gate:** `WgStatus.state == up` (fleet boards only).

### 5. Config — calibration + boot subsystems (skill: `config-hardware`)

```bash
strawberry system flags  --host $HOST [--onewire on] [--modbus ...] [--zigbee ...] [--can ...]
strawberry system config --host $HOST [--ws2812-count N] [--hx711-scale ...] [--flow1-ppl ...] \
                                      [--timezone TZ] [--ntp-server S] [--display-layout ...]
strawberry ow-config apply --host $HOST --rom <HEX> --channel <FILE.json>   # DS2450/DS2423 boards
```

Flags persist to NVS and take effect **on next reboot** — reboot if you changed any:

```bash
strawberry reboot --host $HOST                                   # only if a flag actually changed
skills/setup-board/scripts/dwell-3x.sh --host $HOST --token-file <t>   # validate recovery
HOST="$(skills/setup-board/scripts/resolve-host.sh --cidr <lan-cidr> --mac <board-mac>)"  # lease may have moved
```

**Gate:** config written; if flags changed, reboot validated dwell+3x and `$HOST` re-resolved.

### 6. Firmware — bring to target revision (skill: `flash-ota`) [SIGN-OFF]

> Destructive: this reboots the unit. **Get human sign-off first.**

```bash
strawberry ota upload --host $HOST --combined <img>                   # fw + web-UI in lockstep
skills/setup-board/scripts/dwell-3x.sh --host $HOST --token-file <t>   # dwell, then confirm 3x
HOST="$(skills/setup-board/scripts/resolve-host.sh --cidr <lan-cidr> --mac <board-mac>)"  # lease may have moved
strawberry auth resume --host $HOST --token-file <t>                  # re-auth after the reboot
strawberry query ota  --host $HOST --json                             # confirm target revision
```

Prefer `--combined` to keep firmware and web UI in lockstep. **Never claim done on a probe-too-soon
read** — `dwell-3x.sh` enforces the dwell + three consecutive healthy probes.

**Gate:** target revision reported by `query ota`; `dwell-3x.sh` exited 0 (pushes resumed,
min_free healthy).

### 7. Build unit — compose + wire (skill: `build-grow-unit`)

```bash
strawberry grow unit-set            --host $HOST --id grow.1 --name '<Name>' [--kind K] --active
strawberry grow io-add              --host $HOST --unit grow.1 --name <ep> --role <input|output> --dtype <t> [...]
strawberry controllers graph-apply  --host $HOST --nodes <graph.json>    # atomic create+wire, rollback-safe
strawberry grow schedule-set        --host $HOST --unit grow.1 --schedule <schedule.json>
strawberry box set                  --host $HOST --unit grow.1 --data <box.json>   # optional Control Box HMI
```

Or one-shot a proven design: `strawberry unit import --host $HOST --file <design.json>` (skill:
`import-export`). `graph-apply` is idempotent via re-bind.

**Gate:** `query grow_config` shows the unit; `controllers list` shows no orphans.

### 8. Verify — health + dynamics (skill: `diagnose`)

```bash
strawberry query grow_config --host $HOST --json        # unit present, no orphan endpoints
strawberry diag stress       --host $HOST               # 7-phase system stress
strawberry diag boundary     --host $HOST               # capacity boundary (min_free >= ~28K, no UAF)
strawberry record --host $HOST --topics stats,io,controllers --out run.jsonl --seconds <N>
```

**Gate:** no orphans, `min_free` >= ~28K, no UAF, live dynamics captured. **Board is now
running+configured.**

## When a step fails — recover, don't bulldoze

The orchestrator is resumable; do not restart from zero on a transient failure.

- **A step "loses" the board (timeout / disconnect).** First suspect a drifted lease, not a crash:
  re-run `scripts/resolve-host.sh --cidr ... --mac ...`, then `strawberry auth resume
  --token-file <t>`. Only if `dwell-3x.sh` cannot reach 3 healthy probes do you treat it as a real
  hang (serial/USB recovery is out of CLI scope — escalate to a human).
- **`auth login` fails.** Wrong password or a stale token. Re-read the printed-label password;
  `strawberry auth revoke --host $HOST --token-file <t>` to clear server-side, then re-login.
- **Wi-Fi (step 3) never connects.** The board stays on SoftAP; `$HOST` is still the SoftAP IP.
  Re-check SSID/pass and re-issue `net wifi`; do not advance until `query wifi` shows a LAN IP.
- **WireGuard (step 4) never comes up.** `strawberry wg disable --host $HOST` to back it out, fix
  the `.conf` (endpoint reachability / `AllowedIPs`), re-apply. Non-fleet boards skip this entirely.
- **OTA (step 6) fails mid-stream or the reboot wedges.** The dual-bank layout means the *running*
  slot is untouched until `OtaUploadEnd` commits — a failed upload leaves the old firmware bootable.
  If `dwell-3x.sh` fails, do **not** re-flash blindly: re-resolve + resume; if still dead, this is
  the one place to escalate (USB fallback) before retrying the OTA.
- **Graph-apply (step 7) is rejected.** `CtrlGraphApply` is atomic and rolls back on failure, so the
  unit is left in its prior state — fix the offending node/binding in `graph.json` and re-apply
  (idempotent re-bind). Endpoints missing? Add them (step 7 `io-add`) before re-applying the graph.
- **Destructive verbs are gated.** `factory-reset` and `grow-erase` are never auto-run by this
  orchestrator; they wipe NVS/units and require explicit human sign-off, same as OTA.

## Sign-off checklist

- [ ] Board confirmed by MAC (not just an IP).
- [ ] Token persisted 0600; resume works across a reboot.
- [ ] Every later step gated to the board's real capabilities.
- [ ] Human sign-off obtained before factory-reset / grow-erase / OTA.
- [ ] Every reboot validated dwell+3x (`system_mode=NORMAL`, pushes resumed).
- [ ] At least one unit built and verified with no orphans.
- [ ] Diagnose pass recorded (heap healthy, stress + boundary clean).

## See also

- Helper scripts (this dir): `scripts/resolve-host.sh` (resolve `$HOST` by MAC),
  `scripts/dwell-3x.sh` (reboot-recovery gate). Both wrap `strawberry`; zero extra deps.
- Per-step skills: `reach-and-auth`, `provision-network`, `flash-ota`, `config-hardware`,
  `build-grow-unit`, `import-export`, `diagnose` (sibling dirs under `skills/`).
- Library: `@avatarsd-llc/device-client` — the shared WS+protobuf core the CLI is built on
  (ADR-0066 in `strawberry-fw/doc/adr/`).
