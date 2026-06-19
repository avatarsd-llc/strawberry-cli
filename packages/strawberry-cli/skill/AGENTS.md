# AGENTS.md — strawberry-cli agent skills

Entry pointer for an agent that lands in this directory. These are Claude Code agent
skills that drive the `strawberry` CLI (`bin/strawberry-cli.mjs`) to set up an arbitrary
Gorshok-v4 board. Each skill is a sibling directory with its own `SKILL.md` (YAML
front-matter + instructions); there is no top-level skill manifest — the harness loads
each `<name>/SKILL.md` on its own.

## Where to start

- **Setting up a board end to end?** Invoke **`setup-board`** — the orchestrator. It
  sequences every per-step skill in the canonical order and stops for sign-off before
  destructive steps. See [`setup-board/SKILL.md`](./setup-board/SKILL.md).
- **Doing one stage only?** Pick the matching per-step skill directly. The full table
  (purpose + key CLI verbs) is in [`README.md`](./README.md).

## Skills (one directory each)

| Skill | What it drives |
|-------|----------------|
| [`setup-board`](./setup-board/SKILL.md) | Orchestrator: fresh board -> running+configured, sequencing all of the below. |
| [`reach-and-auth`](./reach-and-auth/SKILL.md) | Discover by MAC (WS probe, no mDNS), HMAC login, persist a 0600 token. |
| [`provision-network`](./provision-network/SKILL.md) | Wi-Fi STA, optional HA MQTT, optional WireGuard fleet join. |
| [`flash-ota`](./flash-ota/SKILL.md) | OTA app/spa/combined over WS, validated dwell+3x. |
| [`config-hardware`](./config-hardware/SKILL.md) | Persisted hardware config, boot subsystem flags, 1-Wire IO boards. |
| [`build-grow-unit`](./build-grow-unit/SKILL.md) | Compose a cultivation unit: endpoints, atomic controller graph, schedule, Control Box. |
| [`import-export`](./import-export/SKILL.md) | Lossless unit/device blueprint save + restore (secrets redacted, device key never serialized). |
| [`diagnose`](./diagnose/SKILL.md) | Heap trend, system stress, capacity boundary, JSONL stream recording. |

## How these skills work

Every skill is a **thin wrapper over the `strawberry` CLI** — it adds no second client.
The CLI is a front end over the shared `@avatarsd-llc/strawberry-client` library (the one
WS+protobuf core). Discover the command vocabulary from `strawberry help
--json` rather than hard-coding it — the tree is generated from the library's live
protobuf enums.

## Ground rules every skill obeys

- Locate the board **by MAC** — DHCP leases drift; a stale IP looks like a crash but isn't.
- The firmware ships **no mDNS**; discovery is WS-probing candidate IPs.
- **HMAC** login only — the plaintext password never crosses the wire.
- **Destructive steps** (factory-reset, grow-erase, OTA) reboot the unit — stop for human sign-off.
- Validate any reboot with **dwell+3x** (reboot landed, `system_mode=NORMAL`, pushes resumed).
- Keep WS clients **<= 2** to avoid the C6 httpd multi-client wedge.

## See also

- Skill index (full table): [`README.md`](./README.md)
- CLI: `strawberry` / `strawberry-cli` (`../bin/strawberry-cli.mjs`)
- Library + protocol docs: repository [`README.md`](../README.md)
