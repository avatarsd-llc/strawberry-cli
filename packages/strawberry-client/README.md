# @avatarsd-llc/strawberry-client

Open-source, **framework-free** TypeScript WebSocket + protobuf client for the
**Strawberry** (Gorshok-v4) ESP32-C6 grow controller: `DeviceClient`, a generated
protobuf-ts codec, and a pure-JS HMAC. Runs unchanged in a browser, in Node, and in a
Pulumi provider host — no Angular, no RxJS, no framework lock-in.

It is the shared core consumed by the firmware's web-ui SPA, a Pulumi deploy provider, and
the [`@avatarsd-llc/strawberry-cli`](../strawberry-cli) CLI, and is embedded in
[`avatarsd-llc/strawberry-fw`](https://github.com/avatarsd-llc/strawberry-fw) as a git
**submodule** at `packages/strawberry-client`.

## Install

```bash
npm i @avatarsd-llc/strawberry-client
```

**Node 22+** is the baseline: Node ships a global `WebSocket` from v22, so the library
works with no extra dependency. The [`ws`](https://www.npmjs.com/package/ws) package is an
**optional** peer dependency, dynamically imported only by the `./node` transport for
older runtimes or when you want to inject a WebSocket implementation. In a browser the
global `WebSocket` is used automatically.

## Quick start

`DeviceClient` drives a `{ transport, codec }` pair and never names a WebSocket or a wire
format directly (the [transport + codec seam](#transport--codec-seam)). The static
`forWsHost` helper wires the default `WsTransport` + protobuf codec for you. `--host` may
be a bare host, `host:port`, or a full `ws(s)://…/ws` URL.

```ts
import { DeviceClient, Query_What, Topic } from '@avatarsd-llc/strawberry-client';
import { commands } from '@avatarsd-llc/strawberry-client';

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
import { NodeWsTransport, FileTokenStore } from '@avatarsd-llc/strawberry-client/node';
import { DeviceClient, wsUrlForHost } from '@avatarsd-llc/strawberry-client';

const transport = await NodeWsTransport.create(wsUrlForHost('192.168.1.117'));
const client = new DeviceClient({ transport, tokenStore: new FileTokenStore('/path/to.token') });
```

## WS protocol surface

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

Full reference: [`docs/protocol.md`](./docs/protocol.md) and [`docs/library.md`](./docs/library.md).

### Firmware quirks

Verified against real hardware (see [`../../HIL-FINDINGS.md`](../../HIL-FINDINGS.md)):

- **`stats` and `snapshot` are push-only.** The firmware has no `query` case for
  `WHAT_STATS` (returns `unknown query`); `WHAT_SNAPSHOT` broadcasts and then replies with
  a bare `Ack`. Read both by subscribing to `TOPIC_STATS` / `TOPIC_SNAPSHOT` via
  `client.push`, not through `query`. The library enforces this — `query()` throws on a
  push-only `WHAT` rather than handing back a mistyped payload.
- **Session resume is single-connection-only.** The firmware binds each auth token to the
  socket that created it and revokes it on socket close (the 8-slot-leak fix). So a token
  cannot be resumed across separate process invocations or after a reconnect — `resume` on
  a new socket gets `419 token expired`. Hold a token only within one long-lived
  connection; otherwise log in fresh.

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
| `./proto`  | the raw protobuf-ts message vocabulary (`ClientMessage`/`ServerMessage`/…) | CLI command modules |

## Build & test

From the monorepo root (workspace-aware):

```bash
npm install
npm run proto -w @avatarsd-llc/strawberry-client   # regenerate src/proto/messages.ts (gitignored)
npm run build -w @avatarsd-llc/strawberry-client   # tsup -> dist/ (ESM + CJS + .d.ts), four subpaths
npm run test  -w @avatarsd-llc/strawberry-client   # vitest: HMAC vector + codec round-trips + protocol matrix
```

Or from this package dir: `npm run proto`, `npm run build`, `npm test`.

Validation is layered:

- **Protocol matrix** ([`test/ws-protocol-matrix.test.ts`](./test/ws-protocol-matrix.test.ts))
  — data-driven over the generated codec's reflection: every one of the 64 `ClientMessage`
  commands and 38 `ServerMessage` types round-trips encode→decode, and the
  `Query.What`/`Topic` counts are asserted. Exhaustive by construction.
- **HIL** (hardware-in-the-loop) — [`../../HIL-FINDINGS.md`](../../HIL-FINDINGS.md) is the
  running catalog of behavior against a live Gorshok-v4 board.

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

## License

[Apache-2.0](./LICENSE), (c) Avatars LLC.
