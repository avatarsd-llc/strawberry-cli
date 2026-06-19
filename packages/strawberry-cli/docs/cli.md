# strawberry-cli command reference

`strawberry` is a framework-free command-line client for the Strawberry (Gorshok-v4) grow
controller. It is the third consumer of [`@avatarsd-llc/strawberry-client`](../../strawberry-client/docs/library.md) (the
shared WS+protobuf core): every command opens a `DeviceClient` session over a Node WebSocket
transport with a `0600` file-backed token store, runs the SEC-001 HMAC login, and drives the
command. It supersedes the hand-rolled Python in the firmware's `tools/` (`ota_upload.py`,
`wg_provision.py`, `verify_grow.py`, the `ws_*_stress.py` family).

- Binary: `strawberry` (alias `strawberry-cli`).
- Runtime: Node 22+ (the built-in global `WebSocket` is used; on older Node the optional `ws`
  package is needed).
- Protocol: see [`protocol.md`](../../strawberry-client/docs/protocol.md). The CLI's vocabulary is generated from the
  library's live protobuf enums, so `strawberry help --json` is the provable command/query set.

## Invocation

```
strawberry <command> [subcommand] [args] --host <H> [--password P] [--json]
```

`strawberry` with no command, `strawberry help`, or `--help` prints the command tree. Running a
command with no subcommand prints that command's usage. An unknown command exits `127`.

### Global flags

| Flag | Meaning |
|------|---------|
| `--host H` | Board address: bare IP (`10.5.60.177`), `host:port`, or a full `ws(s)://.../ws` URL. The CLI normalizes a bare host to `ws://<host>/ws`. Required for every device command. |
| `--password P` | Plaintext device password. Only the HMAC ever crosses the wire (SEC-001). |
| `--password-file F` | Read the password from a file (trailing newline trimmed). Preferred — keeps the secret out of shell history. |
| `--token-file F` | Override the default per-host token path (`~/.strawberry/tokens/<host>.token`, mode `0600`). |
| `--ttl-ms N` | Desired session TTL in ms (`0` = server default, clamped 60 s..7 d). |
| `--no-prompt` | Never prompt interactively for a password (for non-interactive wrappers that have a TTY). |
| `--json` | Machine-readable JSON output. |

### Password resolution order

1. `--password VALUE`
2. `--password-file FILE`
3. `$STRAWBERRY_PW` or `$STRAWBERRY_PASSWORD`
4. interactive hidden prompt (only when stdin is a TTY and `--no-prompt` is absent)

If none resolve, the command fails with a clear error. The plaintext password is never logged
and never sent — `DeviceClient.login` sends only `HMAC-SHA256(password, server-nonce)`.

### Session model and auth resume

Every command opens a fresh socket, logs in (or auto-resumes a stored token), runs, and
disconnects. **Token persistence cannot resume a session across CLI invocations on current
firmware**: the firmware binds each token to its issuing socket and revokes it on close
(see [`protocol.md`](../../strawberry-client/docs/protocol.md) quirk 1), so a new process replaying the stored token gets
`419 token expired`. In practice every command just logs in fresh, which works. The token file
is still written `0600` and `auth resume` / `auth revoke` exist, but treat them as
single-connection only.

### Exit codes

`0` success; `1` generic error; `2` auth/usage failure (e.g. login rejected, the
`provision identity` stub); `3` a watch/poll deadline elapsed without the desired state (e.g.
`wg status --watch` timed out before the peer came up); `127` unknown command. On `--json`,
errors print `{ "ok": false, "error": "..." }`.

## Commands

### `info` / `connect`

Open an authenticated session and print the board identity: `Capabilities`, `SystemFlags`,
`WifiState`. The fast "is this board reachable and who is it" check. `connect` is an alias.

```bash
strawberry info --host 10.5.60.177 --password-file ./pw
strawberry info --host 10.5.60.177 --json
```

Reports `bootOffsetMs` (note: unreliable on current firmware, see protocol).

### `query <what>`

One-shot pull of a `Query.What` state. Verbs (generated from the live enum):

```
ow_sensors  soil  wifi  ha  ota  device_list  device_config  time
grow_config  system_flags  wireguard  wg_status  capabilities  ow_config
```

`stats` and `snapshot` are intentionally **absent** — they are push-only (subscribe to the
topic instead; see protocol quirk 2). A push-only or error reply surfaces as a clean failure.

```bash
strawberry query wifi --host $HOST --json
strawberry query grow_config --host $HOST
```

### `auth <login|resume|revoke>`

SEC-001 session lifecycle.

- `login` — HMAC challenge-response; persists the token to the file store.
- `resume` — replay a stored token (single-connection only; see session model).
- `revoke` — invalidate the token server-side and clear it locally.

```bash
strawberry auth login  --host $HOST --password-file ./pw --token-file ./board.token --ttl-ms 86400000 --json
strawberry auth resume --host $HOST --token-file ./board.token --json
strawberry auth revoke --host $HOST --token-file ./board.token
```

### `net <wifi|ha|info>`

Provision Wi-Fi STA credentials and the Home-Assistant MQTT auto-discovery integration, and
read live `WifiState` / `HaConfig`. `net wifi` moves a fresh board off SoftAP onto the LAN — the
device reassociates and its DHCP IP changes, so re-resolve `--host` afterward.

| Subcommand | Flags |
|------------|-------|
| `wifi` | `--ssid S` (required), `--wifi-pass P` |
| `ha` | `--enabled`, `--mqtt-uri U` (required if `--enabled`), `--mqtt-user`, `--mqtt-pass`, `--prefix` |
| `info` | (none) — prints `WifiState` + `HaConfig` |

```bash
strawberry net wifi --host $HOST --ssid Skybox --wifi-pass 'secret'
strawberry net ha   --host $HOST --enabled --mqtt-uri mqtt://10.5.60.1:1883 --mqtt-user ha --mqtt-pass pw
strawberry net info --host $HOST --json
```

### `provision <wifi|wireguard|identity>`

Convenience aliases so the setup flow reads top-to-bottom.

- `wifi` -> same as `net wifi`.
- `wireguard` (alias `wg`) -> same as `wg apply`.
- `identity` (alias `claim`) -> a documented **stub** that refuses: the ADR-0060 factory-identity
  QR claim is design-only, with no firmware claim surface yet (`mfg_data` is read-only). Exits `2`.

### `wg <apply|disable|status>`

Provision the device WireGuard client from a `wg-quick` `.conf` and poll the tunnel state.
Supersedes `tools/wg_provision.py`.

| Subcommand | Flags |
|------------|-------|
| `apply` (alias `set`) | `--conf <wg-quick.conf>` (required) |
| `disable` | (none) — tears down the tunnel; leaves the stored key untouched |
| `status` | `--watch N` (poll up to N seconds until the peer comes up) |

`apply` parses `[Interface]`/`[Peer]` and derives the on-link netmask from the `AllowedIPs`
subnet. The applied private key is redacted in output. `status --watch` exits `3` if the peer
is still not up at the deadline.

```bash
strawberry wg apply  --host $HOST --conf ~/fleet/gorshok-ab48.conf
strawberry wg status --host $HOST --watch 60 --json
strawberry wg disable --host $HOST
```

### `ota upload`

Push firmware/web-UI over WS. Exactly one of:

| Flag | Target | Effect |
|------|--------|--------|
| `--bin F` | app slot (0) | flashes the app; reboots |
| `--spa-bin F` | spa partition (1) | flashes the web UI; applies on next page load (no reboot) |
| `--combined F` | combined (2) | a `mk_combined` `SBC1` `[spa][app]` stream; reboots |

`--chunk-timeout S` overrides the per-chunk ack window (default 15 s). For app/combined targets
the reboot drops the socket before the End ack — that is treated as success; validate afterward
with `query ota` + `diag heap`.

```bash
strawberry ota upload --host $HOST --combined ~/builds/strawberry-fw-combined.img
strawberry ota upload --host $HOST --spa-bin ~/builds/spa.img --json
```

### `system <config|flags>`

Persisted hardware/runtime config and boot-time subsystem enables.

`config` (`ConfigSet`) — every field optional; only the flags you pass are written:

```
--password  --timezone  --ntp-server  --theme  --stats-period-ms  --ws2812-count
--hx711-scale  --hx711-offset  --gpio2-mode  --flow1-ppl  --flow2-ppl
--display-layout  --display-rotation
```

At least one field is required. `--password` is redacted in output.

`flags` (`SystemFlagsSet`) — toggle the boot subsystems. Each is a tri-state over the current
value: `--onewire` / `--onewire on|off`, `--no-onewire`; likewise `--modbus`, `--zigbee`,
`--can`. Unspecified flags are preserved (the CLI reads current `SystemFlags` first). Changes
persist to NVS and **take effect on next reboot**; if nothing changed the CLI reports "unchanged"
and writes nothing.

```bash
strawberry system config --host $HOST --ws2812-count 12 --flow1-ppl 450 --timezone 'Europe/Kyiv'
strawberry system flags  --host $HOST --modbus on --no-zigbee --json
```

### `grow <subcommand>`

Build a cultivation unit. Supersedes `tools/verify_grow.py`.

| Subcommand | Flags | Notes |
|------------|-------|-------|
| `unit-set` (alias `unit-create`) | `--id` (required, e.g. `grow.1`), `--name`, `--kind`, `--inactive` | Defaults the unit **active** (only active units materialize endpoints). |
| `unit-remove` | `--id` (required) | |
| `unit-list` (alias `list`) | (none) | lists units from `GrowConfig` |
| `io-add` | `--unit`, `--name` (required), `--role`, `--dtype`, `--unit-hint`, `--mqtt` | adds a user-defined IO endpoint `<unit>.<name>` |
| `io-remove` | `--unit`, `--name` (required) | |
| `io-list` | `--unit` (required) | lists a unit's endpoints |
| `schedule-set` | `--unit`, `--schedule FILE.json` (required), `--derived-mask` | pushes a unit's working schedule |

`--kind` is one of `substrate` (default), `hydro_pure`, `hydro_substrate`, `aero`, `aquaponic`,
`aquarium`. `--role` is `input` (default), `output`, or `virtual`. `--dtype` is `bool`, `i32`,
`u32`, or `f32` (default). `--mqtt` sets the MQTT-exposed flag. The schedule JSON is
`{ params: [...], stages: [...], derivedMask?: N }`.

```bash
strawberry grow unit-set --host $HOST --id grow.1 --name 'Basil' --kind substrate
strawberry grow io-add   --host $HOST --unit grow.1 --name temp --role input --dtype f32 --mqtt
strawberry grow io-list  --host $HOST --unit grow.1 --json
strawberry grow schedule-set --host $HOST --unit grow.1 --schedule ./schedule.json
```

### `controllers <graph-apply|list|destroy>`

Wire the controller dataflow graph.

- `graph-apply --nodes FILE.json [--timeout-ms N]` — land the whole dependency-ordered graph
  atomically: creates all nodes, then binds; rolls back on failure; idempotent re-bind. Default
  timeout 30 s (raise it on a loaded device). The JSON is an array (or `{ "nodes": [...] }`) of:

  ```json
  [{ "kind": "...", "instanceId": "...", "params": "<base64>",
     "inputs":  [{ "slot": 0, "ioId": "grow.1.temp" }],
     "outputs": [{ "slot": 0, "ioId": "grow.1.heater" }] }]
  ```

- `list` — list live controllers (`instanceId`, kind, enabled, status, inputs/outputs, builtin).
- `destroy --id <instance_id>` (or as a positional) — destroy one controller instance.

```bash
strawberry controllers graph-apply --host $HOST --nodes ./graph.json --timeout-ms 60000
strawberry controllers list    --host $HOST --json
strawberry controllers destroy --host $HOST --id ctrl.pid.1
```

### `diag <heap|stress|logs>`

On-device health. Stats is push-only, so these subscribe to `TOPIC_STATS` rather than querying.

- `heap [--seconds N]` (default 10) — poll pushed `Stats` for N seconds; report free-heap trend,
  `min_free` watermark, and largest-block.
- `stress [--iterations N]` (default 10) — light unit churn (create/destroy a throwaway unit)
  while watching `min_free`. A capacity smoke test, not the full firmware stress harness.
- `logs [--seconds N]` (default 10) — subscribe `TOPIC_LOG` and stream `LogEntry` lines.

```bash
strawberry diag heap   --host $HOST --seconds 20
strawberry diag stress --host $HOST --iterations 20 --json
strawberry diag logs   --host $HOST --seconds 30
```

### `reboot [--factory-reset|--grow-erase]`

Device lifecycle. Plain `reboot` is a clean restart. `--grow-erase` wipes units/schedules/graph
(Wi-Fi creds and system settings survive). `--factory-reset` is a full wipe including Wi-Fi creds
(guarded by a confirm magic word). The reboot drops the socket before the ack — treated as
success. The two destructive flags are mutually exclusive.

```bash
strawberry reboot --host $HOST
strawberry reboot --host $HOST --grow-erase --json
strawberry reboot --host $HOST --factory-reset
```

### `raw --msg FILE.json`

The escape hatch: send any `ClientMessage` payload oneof and print the decoded `ServerMessage`.
For any of the 64 variants the typed commands don't wrap. `--timeout-ms N` overrides the reply
window. The JSON is the protobuf-ts `payload` oneof shape; `bytes` fields must be base64 and are
not auto-decoded here.

```bash
strawberry raw --host $HOST --msg ./msg.json --json
# msg.json: { "oneofKind": "query", "query": { "what": 5 } }
```

### `help [--json]`

Print the full command tree. `--json` emits the entire tree (global flags, env vars, commands,
query verbs) machine-readably from the single `CommandSpec` table, so help can never drift from
dispatch.

## Notes for skill/agent drivers

The agent skills in [`../skill/`](../skill/) drive this CLI. A few skill steps reference verbs
that are **not yet implemented** in the CLI as of this writing — notably `discover`,
`record`, `box set`, `unit/device import/export`, `ow-config`, and `diag boundary`. Treat
`strawberry help --json` as the source of truth for what actually exists; connect by `--host`
directly where `discover` is unavailable.
