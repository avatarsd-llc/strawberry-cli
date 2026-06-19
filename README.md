# @avatarsd-llc/strawberry-cli

Open-source, framework-free TypeScript client for the **Strawberry** (Gorshok-v4)
ESP32-C6 grow controller, exposed as **one artifact with four faces**:

1. **Library** — a framework-free WebSocket + protobuf client (`DeviceClient`, a
   generated codec, a pure-JS HMAC). Runs unchanged in a browser and in Node — no
   Angular, no RxJS, no framework lock-in.
2. **CLI** — `strawberry`, a board-setup command surface over the library. Supersedes
   the firmware's hand-rolled `tools/*.py` (`ota_upload.py`, `wg_provision.py`,
   `verify_grow.py`, the `ws_*_stress.py` family).
3. **Skill** — Claude Code agent skills under [`skill/`](./skill/) that drive the CLI to
   bring up an arbitrary board, end to end.
4. **Docs** — this file plus the WebSocket protocol reference it links to.

It is consumed by the firmware's web-ui SPA, a Pulumi deploy provider, and this CLI,
and is embedded in [`avatarsd-llc/strawberry-fw`](https://github.com/avatarsd-llc/strawberry-fw)
as a git **submodule** at `packages/device-client`.

## Install

```bash
npm i @avatarsd-llc/strawberry-cli
```

**Node 22+** is the baseline: Node ships a global `WebSocket` from v22, so the library
and CLI work with no extra dependency. The [`ws`](https://www.npmjs.com/package/ws)
package is an **optional** peer dependency, dynamically imported only by the `./node`
transport for older runtimes or when you want to inject a WebSocket implementation. In a
browser the global `WebSocket` is used automatically.

---

## Quick start

### (a) Library

`DeviceClient` drives a `{ transport, codec }` pair and never names a WebSocket or a
wire format directly (the [transport + codec seam](#transport--codec-seam)). The static
`forWsHost` helper wires the default `WsTransport` + protobuf codec for you. `--host` may
be a bare host, `host:port`, or a full `ws(s)://…/ws` URL.

```ts
import { DeviceClient, Query_What, Topic } from '@avatarsd-llc/strawberry-cli';
import { commands } from '@avatarsd-llc/strawberry-cli';

const client = DeviceClient.forWsHost('192.168.1.117', {
  requestMode: 'sequential', // 'concurrent' (default, rid Map) | 'sequential' (one in-flight)
});

await client.connect();                 // opens the transport; auto-resumes a stored token
await client.login('strawberry');       // SEC-001 HMAC; plaintext password NEVER hits the wire

const caps = await client.query(Query_What.CAPABILITIES); // typed one-shot pull
await client.sendExpectAck(commands.growUnitSet({ id: 'grow.1', name: 'Basil', active: true }));

client.push.on('stats', (s) => console.log('min_free', s.minFreeHeap)); // push topics
await client.subscribe(Topic.STATS);

client.disconnect();
```

`requestMode` selects request/reply discipline: `'concurrent'` tracks replies by
`request_id` and lets them overlap (the SPA default); `'sequential'` is one-in-flight
(what the CLI and the Pulumi provider use). On Node without a global WebSocket, build the
transport from the `./node` subpath:

```ts
import { NodeWsTransport, FileTokenStore } from '@avatarsd-llc/strawberry-cli/node';
import { DeviceClient, wsUrlForHost } from '@avatarsd-llc/strawberry-cli';

const transport = await NodeWsTransport.create(wsUrlForHost('192.168.1.117'));
const client = new DeviceClient({ transport, tokenStore: new FileTokenStore('/path/to.token') });
```

### (b) CLI — `strawberry`

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
them by subscribing to their topics, not by querying (see [firmware quirks](#firmware-quirks)).

### (c) Skill — drive a board from a Claude Code agent

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

### (d) WS protocol surface

The wire protocol is `proto/messages.proto` (a oneof + `request_id` envelope in both
directions; `request_id == 0` means an unsolicited push). The current surface:

| Element | Count |
|---------|-------|
| `ClientMessage` commands | **64** |
| `ServerMessage` types | **38** |
| `Query.What` pullable states | **17** |
| push `Topic`s | **13** |

Auth is **SEC-001** HMAC challenge-response: `AuthChallengeReq` -> `AuthChallenge{nonce}`
-> `HMAC-SHA256(password, nonce)` computed in **pure JS** (the device serves over plain
`http`, where `crypto.subtle` is `undefined`, so there is no `crypto.subtle` /
`node:crypto` dependency) -> `AuthLogin{hmac}` -> `AuthOk{token}`. The plaintext password
never crosses the wire.

Full reference: [`strawberry-fw/doc/ws_protocol_reference.md`](../strawberry-fw/doc/ws_protocol_reference.md),
[`ws_auth_lifecycle.md`](../strawberry-fw/doc/ws_auth_lifecycle.md), and the extraction
decision [`ADR-0066`](../strawberry-fw/doc/adr/0066-device-client-extraction-shared-lib.md).

#### Firmware quirks

Verified against real hardware (see [`HIL-FINDINGS.md`](./HIL-FINDINGS.md)):

- **`stats` and `snapshot` are push-only.** The firmware has no `query` case for
  `WHAT_STATS` (returns `unknown query`); `WHAT_SNAPSHOT` broadcasts and then replies with
  a bare `Ack`. Read both by subscribing to `TOPIC_STATS` / `TOPIC_SNAPSHOT` via
  `client.push`, not through `query`. The library and CLI enforce this — `query()` throws
  on a push-only `WHAT` rather than handing back a mistyped payload.
- **Session resume is single-connection-only.** The firmware binds each auth token to the
  socket that created it and revokes it on socket close (the 8-slot-leak fix). So a token
  cannot be resumed across separate CLI invocations or after a reconnect — `auth resume`
  on a new socket gets `419 token expired`. Hold a token only within one long-lived
  connection; otherwise log in fresh (which every command does).

---

## Transport + codec seam

`DeviceClient` exchanges decoded `ClientMessage` / `ServerMessage` with a
`{ transport, codec }` pair and never names a `WebSocket` or the protobuf runtime. The
shipping pair is `WsTransport` + `ProtobufWsCodec`. A future **libtracer (TLV)** transport
is a drop-in `Transport` + `Codec` implementation — nothing in `commands/*`, the CLI, the
SPA, or the Pulumi provider changes. The one invariant TLV must honor: `request_id` echo,
with `request_id == 0` meaning an unsolicited push.

```ts
export interface Transport {
  connect(): Promise<void>;
  send(data: Uint8Array): void;
  onMessage(cb: (data: Uint8Array) => void): void;
  onClose(cb: () => void): void;
  isOpen(): boolean;
  close(): void;
}
```

Subpath exports keep the SPA graph clean:

| Subpath    | Contains | Consumer |
|------------|----------|----------|
| `.`        | full client: `DeviceClient` + `commands/*` builders + proto + design models | SPA, CLI, Pulumi |
| `./design` | browser-safe pure models only (zero transport deps) | SPA tree-shake |
| `./node`   | `FileTokenStore` (0600 token persistence) + `NodeWsTransport` (`ws`) | CLI, agent-skill |

---

## Build & test

```bash
npm install
npm run proto   # regenerate src/proto/messages.ts from proto/messages.proto (gitignored output)
npm run build   # tsup -> dist/ (ESM .mjs + CJS .cjs + .d.ts), three subpaths
npm test        # vitest: HMAC vector + codec round-trips + the WS protocol matrix + CLI args
```

Validation is layered:

- **Protocol matrix** ([`test/ws-protocol-matrix.test.ts`](./test/ws-protocol-matrix.test.ts))
  — data-driven over the generated codec's reflection: every one of the 64 `ClientMessage`
  commands and 38 `ServerMessage` types round-trips encode→decode, and the
  `Query.What`/`Topic` counts are asserted. If the firmware proto grows a command, the
  count assertions fail until the matrix is updated — it is exhaustive by construction.
- **SIL** (software-in-the-loop) — a mock board under [`sil/`](./sil/) exercises the CLI
  against an in-process / dockerized server: `npm run sil`, `npm run sil:mock`,
  `npm run sil:docker`.
- **HIL** (hardware-in-the-loop) — [`HIL-FINDINGS.md`](./HIL-FINDINGS.md) is the running
  catalog of behavior against a live Gorshok-v4 board; `scripts/hil-matrix.mjs` runs one
  assertion per command against `--host`. 100% line coverage alone cannot catch
  firmware-reality mismatches (push-only state, socket-bound tokens) — the HIL matrix is
  the source of truth for "covers the real device".

Pinned cross-impl HMAC test vector (shared with the firmware's `ws_hmac.c`):

```
HMAC-SHA256("strawberry", 0x00..0x0f) =
  880e5c19ec51b5646794e768dd50f6ec6f7961b9de89dd79852d00d7482bfaed
```

## Proto sync

`proto/messages.proto` is **vendored from `strawberry-fw`** (`components/proto`). It is the
single source of the wire vocabulary; the generated codec (`src/proto/messages.ts`) is
gitignored and rebuilt by `npm run proto` (which defaults `PROTO_DIR` to `./proto`, with an
env override). When the firmware changes the protocol, re-vendor `messages.proto` and
regenerate. The web-ui SPA uses byte-identical generation options so the SPA and this
library share the same codec.

## Used by

- the firmware **web-ui SPA** (the Angular `WsService` becomes a thin adapter over the library),
- the **Pulumi deploy provider** (sequential request mode, env token store),
- this **CLI** and its **agent skills**, and
- embedded as a git **submodule** at `packages/device-client` inside
  [`avatarsd-llc/strawberry-fw`](https://github.com/avatarsd-llc/strawberry-fw).

## License

[Apache-2.0](./LICENSE), (c) Avatars LLC.
