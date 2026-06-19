---
name: config-hardware
description: >
  Set persisted hardware/runtime config and boot-time subsystem enables on a Gorshok-v4 board:
  ws2812 count, hx711 scale/offset, flow ppl, timezone/ntp, stats period, display layout/rotation,
  and toggle 1-wire/modbus/zigbee/can (pending-reboot, NVS-persisted). Configure DS2450/DS2423
  1-Wire IO boards (ADR-0052) where present. Use when asked to calibrate hardware, set ws2812/
  hx711/flow/display config, change timezone/ntp, enable/disable a subsystem, or configure 1-Wire
  IO boards.
---

# config-hardware

Persist a board's hardware calibration and boot-time subsystem enables, gated to what the hardware
actually has. Drives `strawberry-cli` (from `@avatarsd-llc/device-client`) over the device
WS+protobuf surface. No firmware, no serial, no direct WS — every action is a CLI verb.

## When to use

The operator asks to calibrate or configure a board's hardware: ws2812 count, hx711 load-cell
scale/offset, flow pulses-per-litre, timezone/NTP, stats push period, on-device display
layout/rotation; to enable/disable a boot subsystem (1-wire / modbus / zigbee / can); or to set up
DS2450/DS2423 1-Wire IO boards. This is step 5 (CONFIG) of the canonical setup flow, after the
board is reachable and authenticated, and (usually) on the LAN.

## Prerequisites

- **A reachable, authenticated session.** Run `reach-and-auth` first. You need the board's current
  `--host <ip>` and a token file. Because DHCP leases drift, **locate the board by MAC**
  (`e4:b3:23:90:ab:48` is the known dev board) — a stale IP looks like a crash but is just a moved
  lease:

  ```bash
  strawberry discover --cidr 10.5.60.0/24 --mac e4:b3:23:90:ab:48 --json
  # -> pick the matching ip; use it as --host below
  ```

- **The token from the auth step**, passed to every command as `--token-file <t>` (or rely on the
  CLI's stored 0600 FileTokenStore). All commands below also accept `--json` for machine-readable
  output — use it when scripting or asserting.

- **Read capabilities BEFORE writing anything.** Every field must be gated to hardware the board
  actually has (next section). Pull all three state surfaces first:

  ```bash
  strawberry query capabilities  --host "$HOST" --token-file "$TOK" --json
  strawberry query device_config --host "$HOST" --token-file "$TOK" --json
  strawberry query system_flags  --host "$HOST" --token-file "$TOK" --json
  ```

## Capability gating (do not skip)

`ConfigSet` accepts every field unconditionally — the firmware persists what you send. Setting a
field the board has no hardware for is silently inert at best and misleading at worst. Gate against
`Capabilities` (`messages.proto:649`):

| Config field(s)                              | Allowed only when `capabilities`…           |
|----------------------------------------------|---------------------------------------------|
| `--flow1-ppl` / `--flow2-ppl`, `--gpio2-mode`| `flow_sensors == true` (A1 only)            |
| `--hx711-scale` / `--hx711-offset`           | board has the load cell (A1 grow boards)    |
| `--ws2812-count`, `--ws2812-groups`          | always (WS2812 is core)                     |
| `--display-layout` / `--display-rotation`    | `display_kind == "lvgl"` (A2 ST7789V)       |
| `--oled-brightness/-timeout/-sta-metrics`    | `display_kind == "oled"` (A1 SSD1306)       |
| zigbee fields (`--zb-channel`, `--zb-tx-power`, `--zb-install-policy`) | `zigbee == true` (absent on the 4MB prod image) |
| `--analog` related (gpio2 ADC)               | `analog_pin == true` (A1 only)              |
| `--timezone`, `--ntp-server`, `--stats-period-ms`, `--password` | always              |

For subsystem flags, also honor `SystemFlags.zigbee_supported` (`messages.proto:1296`): if it is
`false`, this firmware was built without `CONFIG_APP_ZIGBEE_SUPPORTED` and writing
`--zigbee on` has **no effect** — do not report it as enabled.

## Step 1 — Hardware/runtime calibration (`system config`)

`ConfigSet` (`messages.proto:506`) is all-optional: only the flags you pass are written; everything
else is left untouched. Issue one command with exactly the fields you mean to change.

```bash
strawberry system config --host "$HOST" --token-file "$TOK" \
  --ws2812-count 16 \
  --hx711-scale 412.7 --hx711-offset -8123 \
  --flow1-ppl 450 --flow2-ppl 450 \
  --timezone 'Europe/Kyiv' --ntp-server pool.ntp.org \
  --stats-period-ms 1000 \
  --display-layout 1 --display-rotation 0 \
  --json
# -> Ack
```

Field meanings + safe ranges (from `ConfigSet`):

- `--ws2812-count N` — pixels in the grow-light chain, **1..64**.
- `--ws2812-groups "name:offset:count;..."` — partition the chain into named `ws2812.<name>`
  strip endpoints (ADR-0057 C). Empty = one whole-chain group. **Applies on next boot.**
- `--hx711-scale` / `--hx711-offset` — load-cell calibration (float). Derive empirically:
  offset = raw reading at zero load; scale = counts-per-gram.
- `--flow1-ppl` / `--flow2-ppl` — flow-meter pulses **per litre** (float). `0` = uncalibrated
  (raw pulses/s published). Requires `flow_sensors`.
- `--gpio2-mode 0|1` — GPIO2 function: `0`=ADC, `1`=PCNT (pulse counter).
- `--timezone` — IANA tz id (e.g. `Europe/Kyiv`). `--ntp-server host[:port]` (default
  `pool.ntp.org`).
- `--stats-period-ms N` — `TOPIC_STATS` push period, **clamped 100..10000**.
- `--display-layout 0|1|2|3` — panel grid: `0`=2x2, `1`=3x3, `2`=3x4, `3`=2x3. **Applies on next
  boot** (no live re-layout). LVGL boards only.
- `--display-rotation 0|1|2|3` — `0`/90/180/270°. **Applies on next boot.** LVGL boards only.
- `--password NEW` — rotate the device login secret. After this, **re-authenticate** with the new
  secret (run `reach-and-auth` again) — your current token survives until its TTL but a fresh login
  needs the new password.

This verb also folds `SdInfoReq` (`--sd-info` -> `SdInfo`) and `MpcAuxSet` per ADR-0066 D9; consult
`strawberry help --json` for the live flag list — never hard-code it.

### Verify

```bash
strawberry query device_config --host "$HOST" --token-file "$TOK" --json
```

Assert the fields you set are reflected (`ws2812_count`, `stats_period_ms`, etc.). Display layout/
rotation and ws2812 grouping are **next-boot** — they will NOT show as live until a reboot.

## Step 2 — Boot subsystem flags (`system flags`)

`SystemFlagsSet` (`messages.proto:1279`) toggles which subsystems `app_main` initialises at boot.
It only persists NVS; **the change takes effect on the next reboot** (the UI shows "Pending
reboot"). Pass only the subsystems you mean to change:

```bash
strawberry system flags --host "$HOST" --token-file "$TOK" \
  --onewire on --modbus off --can on \
  --json
# -> Ack
```

- `--onewire on/off` — DS18B20 / DS2450 / DS2423 1-Wire bus.
- `--modbus on/off` — RS485 soil probes. (Note: disabling Modbus frees `UART_NUM_1`; the
  `CONFIG_APP_MODBUS_AS_CONSOLE` debug stub is a firmware build option, not a flag here.)
- `--zigbee on/off` — Zigbee coordinator. **No-op unless `zigbee_supported == true`** (absent on the
  4MB prod image).
- `--can on/off` — CAN domain-bus master (opt-in).

### Reboot to apply (gated)

A flag change is inert until reboot. **[SIGN-OFF]** rebooting interrupts the running grow logic —
get human sign-off before rebooting a live unit. Then:

```bash
strawberry reboot --host "$HOST" --token-file "$TOK"
```

After the reboot, the DHCP IP may move — **re-resolve by MAC** and resume the session:

```bash
strawberry discover --cidr 10.5.60.0/24 --mac e4:b3:23:90:ab:48 --json   # find new ip
strawberry auth resume --host "$NEW_HOST" --token-file "$TOK" --json      # replay token
```

Validate **dwell+3x** (the post-OTA-boot-silence lesson applies to any reboot): wait for the board
to settle, then confirm three good reads before declaring success —

```bash
strawberry query system_flags --host "$NEW_HOST" --token-file "$TOK" --json  # flags now live
strawberry diag heap --host "$NEW_HOST" --token-file "$TOK" --seconds 20     # min_free >= ~28K, no leak
```

A probe too soon after reboot gives a false disconnect/low-heap read — do not claim done on it.

## Step 3 — 1-Wire IO boards (ADR-0052), where present

Only relevant if the board has DS2450 (analog/PWM/GPIO, family `ds2450`) or DS2423 (pulse/flow,
family `ds2423`) modules on the 1-Wire bus, and **1-wire is enabled** (Step 2). First enumerate
the discovered boards + their per-channel config + the capability bitmask the menu must respect:

```bash
strawberry ow-config get --host "$HOST" --token-file "$TOK" --json
# -> OwConfig{ boards:[ { rom, family, label, channels:[ {channel, capabilities, mode, ...} ] } ] }
```

Then write **one channel at a time**. `OwConfigSet` (`messages.proto:1269`) carries one board's
8-byte ROM (hex) + one `OwChannelConfig`; the firmware validates the requested `mode` against that
channel's read-only `capabilities` bitmask, persists NVS, and hot-reloads the running OW task (no
reboot). The channel id is `P0..P3` for DS2450 ADC ports or `C0`/`C1` for DS2423 counters:

```bash
strawberry ow-config apply --host "$HOST" --token-file "$TOK" \
  --rom 20a1b2c3d4e5f600 \
  --channel ./assets/ow-channel-voltage.json \
  --json
# -> Ack
```

`OwMode` values (`messages.proto:1158`): `OW_MODE_VOLTAGE=0` (ADC volts), `OW_MODE_NTC=1` (ADC ->
temp), `OW_MODE_PULSE=2` (DS2423 flow), `OW_MODE_ENCODER=3` (counter pair), `OW_MODE_PWM=4`,
`OW_MODE_DIGITAL_OUT=5`. A channel JSON example ships in `assets/ow-channel-voltage.json`. The
`capabilities` field is server-owned and **ignored on Set** — never invent a mode the
`ow-config get` capability bitmask does not allow; the firmware will reject it.

### Verify

```bash
strawberry ow-config get --host "$HOST" --token-file "$TOK" --json
# assert the channel's mode/settings now match what you applied
```

## Cleanup / rollback

- **No destructive default.** `system config` and `ow-config apply` only set fields you pass; to
  revert one, re-send the prior value (capture it from `query device_config` / `ow-config get`
  before changing anything).
- **Flags:** to roll back a subsystem toggle, re-send the opposite (`--onewire off`) and reboot
  again. Until you reboot, the running state is unchanged regardless of what you wrote.
- **ws2812 groups / display layout / rotation:** next-boot only — re-send the old value and reboot
  to revert.
- **Do not factory-reset to undo a calibration** — that wipes the whole device. Targeted re-sends
  are the correct rollback.

## Non-negotiables

- Gate every field to `capabilities` + `zigbee_supported` (table above). Never set hardware the
  board lacks.
- Discover the live flag vocabulary from `strawberry help --json`; do not hard-code flags this doc
  may have drifted on.
- Flag changes are **pending until reboot** — schedule the reboot, get **[SIGN-OFF]** for a live
  unit, re-resolve by MAC, resume the token, and validate **dwell+3x**.
- Keep WS clients **<= 2** (C6 httpd multi-client wedge).
- Locate by MAC; DHCP drifts.
