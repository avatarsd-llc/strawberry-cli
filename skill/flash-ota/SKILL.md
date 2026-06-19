---
name: flash-ota
description: >
  Bring a Gorshok-v4 board to the target firmware/web-UI revision over WS: upload an app-slot,
  spa-partition, or combined (fw+spa) image, then validate with dwell+3x — confirm the reboot
  landed, system_mode is NORMAL, and pushes resumed — never claiming done on a probe-too-soon
  read. Gated on human sign-off because it reboots the unit. Use when asked to flash a board,
  push firmware/an OTA, update the web UI, or upload a combined image.
---

# flash-ota — push firmware/web-UI over WS, validated dwell+3x

Flash the board to a target revision over the existing WebSocket (no separate HTTP/POST path,
no USB) and **prove** the reboot recovered cleanly before declaring success. Everything here runs
through `strawberry-cli`, the thin front end over `@avatarsd-llc/device-client` (the shared
WS+protobuf core, ADR-0066). This skill supersedes `tools/ota_upload.py` (push OTA),
`tools/ota_update.py` (URL-pull OTA), and `tools/ota_check.py` (post-flash poll).

## Contract

- **Input:** an authenticated, reachable board (`$HOST` = its current `ws://<ip>/ws`, located by
  MAC), the board password (or a stored token), and one image to flash:
  - `--combined <img>` — fw + web-UI in one stream (RECOMMENDED; keeps them in lockstep, reboots), or
  - `--bin <app.bin>` — app slot only (reboots), or
  - `--spa-bin <spa.img>` — web-UI bundle only (applies on next page load, **no reboot**).
- **Output:** the board running the target revision, validated dwell+3x, with the session
  re-authenticated after the reboot.
- **[SIGN-OFF] — destructive.** App and combined images reboot the unit. **Get human sign-off
  before flashing.** (spa-only does not reboot.)

## Non-negotiables

- **[SIGN-OFF]** before any app/combined flash — it reboots the unit.
- **Prefer `--combined`** so firmware and web UI move together; a fw-only flash with a stale SPA,
  or vice-versa, is a split-revision board.
- **Validate dwell+3x** after a reboot-causing flash. A probe issued too soon after OTA gives a
  *false* disconnect / low-fps / "pushes silent" reading (post-OTA the `esp_restart()` task and the
  reboot path can still be settling). Dwell ~10-20 s, then confirm the recovery signals **three
  times** before claiming done.
- **Locate by MAC, not IP.** DHCP leases drift; after the reboot the board may come back on a
  different IP — re-resolve by MAC and update `$HOST`.
- **Re-authenticate after the reboot** via the stored token (`strawberry auth resume`); the old
  socket is gone.
- **Keep WS clients <= 2** — the C6 httpd wedges with 3 concurrent clients. Do not flash while a
  diagnose/record stream is also attached.
- The CLI vocabulary is generated from the library's live protobuf enums — read it with
  `strawberry help --json`, never hard-code flag names from memory.

## Prerequisites

1. The board is reachable and you have an authenticated, resumable session — run the
   `reach-and-auth` skill first. You should hold `$HOST` and a **0600** `--token-file`.

   ```bash
   HOST=ws://<ip>/ws          # the row whose MAC matches the target board
   TOKEN=~/.strawberry/<mac>.token
   ```

2. You have the image(s) to flash, built for this board (`esp32c6`). The packers live in
   `strawberry-fw/tools/` (these stay as build-image packers; only the *upload* path moves to the
   CLI):

   ```bash
   # web-UI bundle -> spa.img (rebuild web-ui first; web-ui/dist is gitignored / goes stale)
   python3 tools/mk_spa_partition.py web-ui/dist/index.html.gz build/spa.img
   # combined fw+spa -> one OTA image (header magic 'SBC1' [app_size][spa_size][spa][app])
   python3 tools/mk_combined.py --app build/strawberry-fw.bin --spa build/spa.img \
       --out build/strawberry-combined.img
   ```

   Match the firmware build to the board's display variant (a1 OLED vs a2 LVGL) — confirm with
   `strawberry query device_config --host $HOST --json` (board_rev / display_kind) before flashing.

## Pick a target mode

| Mode | Flag | What it writes | Reboots? | Use when |
|------|------|----------------|----------|----------|
| Combined | `--combined <img>` | spa partition **then** inactive app slot, one stream | **yes** | the normal case — keep fw + web UI in lockstep |
| App | `--bin <app.bin>` | inactive app slot (dual-bank OTA) | **yes** | fw-only bump and the SPA is already current |
| SPA | `--spa-bin <spa.img>` | spa partition (web-UI blob) | **no** (next page load) | web-UI-only change, no firmware delta |

When in doubt, use **combined**.

## Steps

### 1. Pre-flight — confirm target, capabilities, and a clean baseline

```bash
strawberry query device_config --host $HOST --json    # board_rev / display_kind matches your image
strawberry query ota           --host $HOST --json     # OtaProgress.in_progress == false (no OTA in flight)
strawberry diag heap           --host $HOST --seconds 10 --json   # baseline min_free (expect >= ~28K)
```

**Gate:** image matches the board variant; no OTA already in progress; healthy baseline heap.
Detach any other WS client now (stay <= 2 total during the flash).

### 2. Get human sign-off (app / combined only)

App and combined images reboot the unit. **Stop and obtain explicit human sign-off** before
proceeding. (Skip this gate only for a `--spa-bin` flash, which does not reboot.)

### 3. Upload the image

```bash
# Combined (recommended): single stream, device splits [spa][app] and reboots so both apply together
strawberry ota upload --host $HOST --combined build/strawberry-combined.img --chunk-timeout 15 --json

# App slot only (reboots):
strawberry ota upload --host $HOST --bin build/strawberry-fw.bin --chunk-timeout 15 --json

# SPA only (no reboot; new UI on next page load):
strawberry ota upload --host $HOST --spa-bin build/spa.img --json
```

Wire mechanics (handled by the lib's Node WS codec — here for understanding, not to re-implement):
`OtaUploadBegin{size,target,spa_size,app_size}` -> `OtaChunkAck{next_offset}`, then ack-driven raw
chunk frames `0x01 || LE32 offset || bytes` (the only `0x01` framing; everything else is `0x00`
ClientMessage protobuf), finally `OtaUploadEnd` -> `Ack`. The per-chunk ack is the flow-control:
the next chunk goes only after the prior ack, which backpressures to whatever `esp_ota_write` can
sustain (~200-400 kB/s on the C6).

**Expected:** progress climbs to 100%; for app/combined the **socket drops as the device reboots**
before the final ack lands — that is normal and counts as upload success, not a failure. For
spa-only you get a clean `Ack` and **no reboot**.

**Gate:** upload reached 100% and ended with `Ack` (spa) or a reboot-drop (app/combined).

### 4. Validate dwell+3x — the load-bearing step

Do **not** claim done on the first read after the reboot. Dwell, re-resolve, re-auth, then confirm
the recovery signals three times.

```bash
# 4a. Dwell ~15 s for the reboot to land and tasks to settle (skip for spa-only — no reboot).
#     Re-resolve by MAC in case DHCP moved the board, then update $HOST.
strawberry discover --cidr <lan-cidr> --mac <board-mac> --json     # if the IP may have changed
# HOST=ws://<new-ip>/ws

# 4b. Re-authenticate with the stored token (the old socket is gone).
strawberry auth resume --host $HOST --token-file $TOKEN --json

# 4c. Confirm recovery THREE times, spaced a few seconds apart:
strawberry query ota --host $HOST --json     # OtaProgress.in_progress == false (boot complete)
strawberry diag heap --host $HOST --seconds 10 --json   # pushes resume (Stats stream alive) == system_mode NORMAL
```

`system_mode` returns to NORMAL exactly when push streams resume: while the device is mid-OTA /
mid-reboot, `web_is_ota_active()` keeps pushes silent, so a live, repeating Stats/IO push stream is
the proof that boot finished and the system is serving again. Run 4c **3x** (dwell between) and
require all three to agree — a single early read can read as a false disconnect.

**Gate (all must hold, 3x):**
- `strawberry auth resume` succeeds (token still valid; reconnect accepted).
- `query ota` shows `in_progress == false`.
- `diag heap` shows a live Stats push stream with `min_free` >= ~28K (no regression vs the §1
  baseline).

### 5. Confirm the revision actually changed

Sanity-check that the new image is the one running (don't trust "it rebooted" alone):

```bash
strawberry query device_config --host $HOST --json    # firmware/web-UI revision == target
```

For a combined flash the web UI and firmware should report the same target revision (lockstep).

**Gate:** reported revision matches the image you flashed. **Board is now at the target revision.**

## Helper

`scripts/validate-dwell-3x.sh` wraps step 4 — it re-resolves by MAC (optional), resumes the token,
then polls `query ota` + `diag heap` three times with a dwell, and exits non-zero unless all three
pass. See its `--help`. It shells out to `strawberry`; it does not touch the wire itself.

```bash
scripts/validate-dwell-3x.sh --host "$HOST" --token-file "$TOKEN" \
    [--mac <board-mac> --cidr <lan-cidr>] [--dwell 15] [--min-free 28000]
```

## Cleanup / rollback

- **Upload failed mid-stream** (chunk ack timeout, begin error): the firmware reverts its OTA state
  on abort or socket-close, so the active slot is untouched — the board keeps running the old image.
  Re-resolve by MAC, `auth resume`, confirm with `query ota` (`in_progress == false`), and retry the
  upload. A persistent stall usually means a stale/oversized image or a wedged httpd (a third WS
  client) — drop extra clients and retry.
- **Bad image that boots but misbehaves:** the dual-bank OTA keeps the previous app slot. Re-flash
  the known-good image with the same `ota upload` (it lands in the other slot and boots it). There
  is no CLI "rollback to previous slot" verb — recovery is re-flashing the good image.
- **Board doesn't come back after dwell+3x** (no Stats stream, resume fails, not found by MAC):
  treat as a wedged reboot. The CLI's reach ends here; physical recovery (USB serial console /
  esptool re-flash) is **out of scope for this skill** and is the human's call.
- **Never** declare success on a probe-too-soon read. If §4 is ambiguous, dwell longer and re-run,
  do not lower the bar.

## See also

- Orchestrator: `setup-board` (step 6 is this skill). Prereq: `reach-and-auth` ($HOST + token).
  Follow-up health: `diagnose`.
- OTA wire + image packing: `strawberry-fw/doc/ota_tooling.md`; packers
  `tools/mk_spa_partition.py`, `tools/mk_combined.py` (kept; only the upload path moves to the CLI).
- Library: `@avatarsd-llc/device-client` — the shared WS+protobuf core (ADR-0066).
