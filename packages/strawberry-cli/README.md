# @avatarsd-llc/strawberry-cli

`strawberry` — a framework-free CLI for board setup of the **Strawberry** (Gorshok-v4)
ESP32-C6 grow controller, plus the Claude Code agent skills that drive it. It is a thin
command surface over the [`@avatarsd-llc/strawberry-client`](../strawberry-client) library and
supersedes the firmware's hand-rolled `tools/*.py` (`ota_upload.py`, `wg_provision.py`,
`verify_grow.py`, the `ws_*_stress.py` family).

## Install

```bash
npm i @avatarsd-llc/strawberry-cli      # or: npx @avatarsd-llc/strawberry-cli ...
```

**Node 22+** baseline. The [`ws`](https://www.npmjs.com/package/ws) package is an optional
peer dependency (used by the Node transport); install it if your runtime lacks a global
`WebSocket`.

## CLI

```bash
npx strawberry info --host 192.168.1.117          # reachable? who is it?
export STRAWBERRY_PW='device-password'             # plaintext stays local; only HMAC goes on the wire
npx strawberry query capabilities --host 192.168.1.117 --json
npx strawberry help --json                          # the whole command tree, machine-readable
```

The password is resolved (in order) from `--password`, `--password-file`,
`$STRAWBERRY_PW` / `$STRAWBERRY_PASSWORD`, or an interactive TTY prompt — and **never
crosses the wire**. Global flags: `--host`, `--password` / `--password-file`,
`--token-file`, `--ttl-ms`, `--json`.

| Command       | Purpose |
|---------------|---------|
| `info`        | Connect + print capabilities / system flags / Wi-Fi (alias: `connect`). |
| `query`       | One-shot pull of a device state (14 verbs, e.g. `capabilities`, `wifi`, `device_config`, `grow_config`, `ota`, `wg_status`, `ow_config`). |
| `auth`        | SEC-001 session: `login` / `resume` / `revoke`; writes a 0600 token file. |
| `net`         | Provision Wi-Fi STA creds / Home-Assistant MQTT; read net info (`wifi`/`ha`/`info`). |
| `provision`   | Convenience wrapper: `wifi` / `wireguard` / `identity`. |
| `wg`          | WireGuard fleet overlay: `apply` a wg-quick `.conf` / `disable` / `status`. |
| `ota`         | Push firmware over WS: `--bin` (app) / `--spa-bin` (web UI) / `--combined` (lockstep). |
| `system`      | Persisted hardware/runtime `config` and boot-time subsystem `flags`. |
| `grow`        | Build a unit: `unit-set` / `unit-remove` / `unit-list` / `io-add` / `io-remove` / `io-list` / `schedule-set`. |
| `controllers` | Wire the controller graph: `graph-apply` (atomic, rollback-safe) / `list` / `destroy`. |
| `diag`        | Health: `heap` (free-heap trend + min_free) / `stress` (unit-churn smoke test) / `logs`. |
| `reboot`      | Reboot, or `--factory-reset` / `--grow-erase`. |
| `raw`         | Send any `ClientMessage` from a JSON file (escape hatch). |

`query` excludes `snapshot` and `stats`: those are **push-only** on the firmware — read
them by subscribing to their topics, not by querying. Full command reference:
[`docs/cli.md`](./docs/cli.md).

## Skill — drive a board from a Claude Code agent

The package bundles agent skills under [`skill/`](./skill/). Point a Claude Code agent at
[`skill/setup-board`](./skill/setup-board/SKILL.md) and it will take an arbitrary board
from fresh to running by sequencing the per-step skills, each of which drives the
`strawberry` CLI (it adds no second client). The agent first reads
`strawberry help --json` so every step uses the device's *provable* command vocabulary
rather than a guessed one.

The orchestrator chains these per-step skills (each is also usable on its own — see
[`skill/README.md`](./skill/README.md)):

| Skill | Stage |
|-------|-------|
| [`reach-and-auth`](./skill/reach-and-auth/SKILL.md) | Find the board on the LAN (WS probe, no mDNS), confirm by MAC, SEC-001 login, persist a 0600 token. |
| [`provision-network`](./skill/provision-network/SKILL.md) | Join Wi-Fi STA, optional HA MQTT, optional WireGuard fleet join. |
| [`flash-ota`](./skill/flash-ota/SKILL.md) | Bring to target firmware/web-UI revision (app/spa/combined), validated dwell+3x. |
| [`config-hardware`](./skill/config-hardware/SKILL.md) | Persisted config + boot subsystem flags + 1-Wire IO boards (ADR-0052). |
| [`build-grow-unit`](./skill/build-grow-unit/SKILL.md) | Compose a cultivation unit: create, add IO, atomic graph-apply, schedule, optional Control Box. |
| [`import-export`](./skill/import-export/SKILL.md) | Lossless save/restore of a unit or whole-device design; secrets redacted, device key never serialized. |
| [`diagnose`](./skill/diagnose/SKILL.md) | Health pass: heap trend, system stress, capacity boundary, JSONL recording. |

Canonical order: `discover -> auth -> capabilities -> network -> overlay (fleet) ->
config -> firmware -> build unit -> verify`. The skills locate the board **by MAC**
(DHCP leases drift — a stale IP looks like a crash but isn't), stop for human sign-off
before destructive steps (factory-reset, grow-erase, OTA), and validate every reboot with
a dwell+3x recovery gate.

## Build & test

From the monorepo root (workspace-aware; the library is built/linked automatically):

```bash
npm install
npm run build                          # builds strawberry-client, then this CLI -> dist/cli.{mjs,cjs}
npm run test -w @avatarsd-llc/strawberry-cli   # vitest: CLI args + wg-conf parsing
node packages/strawberry-cli/bin/strawberry-cli.mjs --help
```

**SIL** (software-in-the-loop) — a mock board under [`sil/`](./sil/) exercises the CLI bin
against an in-process server: `npm run sil` (informational; surfaces the documented OPEN
protocol findings as failing rows). The mock board loads the codec from the built
`@avatarsd-llc/strawberry-client` sibling package so it cannot drift from the wire schema.

## License

[Apache-2.0](./LICENSE), (c) Avatars LLC.
