# Skills index

Agent skills for taking a Gorshok-v4 board from fresh to running, via `strawberry-cli`.

Each skill is a directory containing a `SKILL.md` (YAML front-matter + instructions). The
orchestrator chains the per-step skills; any per-step skill can also be invoked on its own.

| Skill | Directory | Purpose | Key CLI verbs |
|-------|-----------|---------|---------------|
| **setup-board** *(orchestrator)* | [`setup-board/`](./setup-board/) | Take an arbitrary board fresh -> running+configured by sequencing every per-step skill in order, stopping for sign-off where the flow is destructive. | `discover`, `help --json`, `auth login`, `query capabilities` |
| reach-and-auth | [`reach-and-auth/`](./reach-and-auth/) | Discover a board on the LAN (WS probe, no mDNS), confirm by MAC, SEC-001 HMAC login, persist token to a 0600 store for resume across reboots. The mandatory first step. | `discover`, `auth login`, `auth resume`, `query capabilities`, `query wifi` |
| provision-network | [`provision-network/`](./provision-network/) | Join the board to the operator network: Wi-Fi STA creds, optional HA MQTT, optional WireGuard fleet join polled until peer up. Moves it off SoftAP. | `net wifi`, `net ha`, `wg apply`, `wg status`, `query wifi` |
| flash-ota | [`flash-ota/`](./flash-ota/) | Bring the board to the target firmware/web-UI revision over WS (app/spa/combined), validated dwell+3x. Gated on sign-off (reboots). | `ota upload`, `query ota`, `diag heap`, `reboot` |
| config-hardware | [`config-hardware/`](./config-hardware/) | Persisted hardware/runtime config + boot-time subsystem flags (1-wire/modbus/zigbee/can, pending-reboot) + 1-Wire IO boards (ADR-0052). | `system config`, `system flags`, `ow-config apply`, `ow-config get`, `query system_flags` |
| build-grow-unit | [`build-grow-unit/`](./build-grow-unit/) | Compose a cultivation unit end to end: create unit, add IO endpoints, atomically apply the controller graph, push the schedule, optional Control Box blob. Idempotent via graph-apply re-bind. | `grow unit-set`, `grow io-add`, `controllers graph-apply`, `grow schedule-set`, `box set`, `query grow_config` |
| import-export | [`import-export/`](./import-export/) | Lossless save/restore of a unit design or a whole-device envelope (secrets redacted by default; device key never serialized). Clone a proven unit onto a fresh board. | `unit export`, `unit import`, `device export`, `device import` |
| diagnose | [`diagnose/`](./diagnose/) | Health pass: free-heap trend + min_free watermark, 7-phase system stress, capacity boundary probe, JSONL recording of push streams. The standing per-iteration HIL check. | `diag heap`, `diag stress`, `diag boundary`, `record`, `query stats` |

## Setup flow (canonical order)

0. **discover** -> 1. **auth** -> 2. **capabilities** -> 3. **network** -> 4. **overlay (fleet)**
-> 5. **config** -> 6. **firmware** -> 7. **build unit** -> 8. **verify**

`setup-board` walks this whole flow. The per-step skills cover one stage each.

## Ground rules every skill obeys

- Locate the board **by MAC** — DHCP leases drift, a stale IP looks like a crash but isn't.
- The firmware ships **no mDNS**; discovery is WS-probing candidate IPs.
- **SEC-001** login only — plaintext password never crosses the wire.
- Discover the command vocabulary from `strawberry help --json`; never hard-code it.
- **Destructive steps** (factory-reset, grow-erase, OTA) reboot the unit — stop for human sign-off.
- Validate any reboot with **dwell+3x** (reboot landed, `system_mode=NORMAL`, pushes resumed),
  not a probe-too-soon read.
- Keep WS clients **<= 2** to avoid the C6 httpd multi-client wedge.
