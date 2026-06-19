# Library API — DeviceClient

`@avatarsd-llc/strawberry-client` is a framework-free TypeScript client for the Strawberry
(Gorshok-v4) grow controller's WS+protobuf interface. It runs unchanged in a browser and in
Node — no Angular, no RxJS. The core (`DeviceClient`) never names a `WebSocket` or a wire
format: it drives a `{ transport, codec, tokenStore }` triple, so an alternate transport (e.g.
a future libtracer TLV codec) drops in unchanged.

This is the same package that backs the [`strawberry` CLI](../../strawberry-cli/docs/cli.md). For the wire contract see
[`protocol.md`](./protocol.md).

## Entry points

| Import specifier | Contains | For |
|------------------|----------|-----|
| `@avatarsd-llc/strawberry-client` | `DeviceClient`, `PushBus`, codec/transport/token seams, `commands.*` builders, the full proto vocabulary | SPA + Node |
| `@avatarsd-llc/strawberry-client/node` | `FileTokenStore` (`0600`) + `NodeWsTransport` (`ws` fallback) + everything above | CLI, agents, Pulumi |
| `@avatarsd-llc/strawberry-client/design` | pure, transport-free blueprint models (scaffold) | SPA tree-shake |

Dual ESM + CJS with `.d.ts`. The proto vocabulary (`ClientMessage`, `ServerMessage`, `Topic`,
`Query_What`, and every message interface) is re-exported from the root, so consumers get the
full wire vocabulary from one import.

## Quick start (Node 22+)

```ts
import { DeviceClient, Query_What, Topic } from '@avatarsd-llc/strawberry-client';
import { NodeWsTransport } from '@avatarsd-llc/strawberry-client/node';
import { FileTokenStore } from '@avatarsd-llc/strawberry-client/node';
import { wsUrlForHost } from '@avatarsd-llc/strawberry-client';

const transport = await NodeWsTransport.create(wsUrlForHost('192.0.2.177'));
const client = new DeviceClient({
  transport,
  tokenStore: new FileTokenStore('./board.token'),
  requestMode: 'sequential',   // one in-flight; the CLI default
  autoReconnect: false,
});

await client.connect();                 // opens the socket; auto-resumes a stored token
if (!client.isAuthed()) await client.login('my-password');   // HMAC

const wifi = await client.query<'wifi'>(Query_What.WIFI);    // typed reply
if (wifi.oneofKind === 'wifi') console.log(wifi.wifi.ip);

client.push.on('stats', (s) => console.log('free heap', s.freeHeap));
await client.subscribe(Topic.STATS);

// ... later
client.disconnect();
```

### Browser

Identical API; construct `WsTransport` (or `DeviceClient.forWsHost(host)`) — the global
`WebSocket` is used automatically. There is no `FileTokenStore` in the browser; use
`LocalStorageTokenStore` (default `MemoryTokenStore` if you don't pass one).

```ts
import { DeviceClient } from '@avatarsd-llc/strawberry-client';
const client = DeviceClient.forWsHost('192.0.2.177');   // global WebSocket + protobuf codec
await client.connect();
await client.login('my-password');
```

## DeviceClient

```ts
new DeviceClient(opts: DeviceClientOptions)
```

| Option | Default | Meaning |
|--------|---------|---------|
| `transport` | (required) | the byte-pipe seam (below) |
| `codec` | `ProtobufWsCodec` | proto<->bytes seam |
| `requestMode` | `'concurrent'` | `'concurrent'` (rid map, overlapping requests) or `'sequential'` (one in-flight) |
| `tokenStore` | `MemoryTokenStore` | HMAC token persistence seam |
| `requestTimeoutMs` | `8000` | default reply window for `send` |
| `autoReconnect` | `true` | reconnect (exponential backoff 500 ms..15 s) after an unexpected close |
| `onStaleClient` | — | called once on `ERR_STALE_CLIENT` (UI reload hook) |

`DeviceClient.forWsHost(host, opts?)` is a convenience that builds a `WsTransport` + default
codec for a bare host / `host:port` / `ws(s)://` URL.

### Connection

- `connect(): Promise<void>` — open the transport; if a token is stored, attempt `AuthResume`
  immediately, then replay the subscription mask if re-authed. Resolves once the socket is open.
- `disconnect(): void` — tear down and stop reconnecting.
- `isConnected()`, `isAuthed()`, `hasToken()` — state predicates.
- `bootOffsetMs()` — `Date.now() - serverNowMs` captured at `AuthOk` (unreliable on current
  firmware, which reports `serverNowMs == 0`).

### Auth (HMAC)

- `login(password, desiredTtlMs = 0): Promise<void>` — full challenge-response:
  `AuthChallengeReq` -> `AuthChallenge{nonce}` -> `HMAC-SHA256(password, nonce)` (pure-JS) ->
  `AuthLogin{hmac}` -> `AuthOk{token}`. The plaintext password never crosses the wire. On
  success the token is adopted into the `tokenStore`.
- `tryResume(): Promise<boolean>` — replay the stored token over a reconnect; clears it on
  `ERR_AUTH_EXPIRED` and fires `authExpired`. Returns whether resume succeeded.
- `logout(): Promise<void>` — `AuthRevoke` the active token server-side and clear it locally.

Note the firmware quirk: tokens are socket-bound, so `tryResume` only works on a connection
whose slot is still alive (not across a process restart). See [`protocol.md`](./protocol.md)
quirk 1.

### Sending commands

- `send(payload, timeoutMs?): Promise<ServerMessage>` — send any `ClientMessage` payload oneof
  and await the rid-matched reply. In sequential mode each send waits for the previous to settle.
  `timeoutMs` overrides the default window (raise it for a whole-unit `CtrlGraphApply`).
- `sendExpectAck(payload, timeoutMs?): Promise<Ack>` — the common command path; resolves the
  `Ack` or throws on `Ack{ok:false}` / `ErrorMsg`.
- `sendChunkRaw(offset, data, timeoutMs = 15000): Promise<number>` — send a raw `0x01` OTA chunk
  frame; resolves the server's next expected offset (the rid-0 `OtaChunkAck`). One chunk in
  flight at a time.

`payload` is the protobuf-ts oneof shape, e.g. `{ oneofKind: 'wifiSet', wifiSet: { ssid, password } }`.

### Queries

- `query<T>(what: Query_What): Promise<Extract<ServerMessage['payload'], { oneofKind: T }>>` —
  one-shot typed pull. Guards the cast: a push-only `What` (e.g. `WHAT_STATS` -> error,
  `WHAT_SNAPSHOT` -> bare `Ack`) throws rather than handing back a mistyped payload. Read the
  result by narrowing on `oneofKind`:

  ```ts
  const r = await client.query<'capabilities'>(Query_What.CAPABILITIES);
  if (r.oneofKind === 'capabilities') use(r.capabilities);
  ```

### Subscriptions

The subscription mask is a bit field (`Topic.*`); the client tracks the current mask locally.

- `subscribe(topics: number): Promise<Ack>` — set the full mask.
- `addTopics(mask)`, `removeTopics(mask)` — incremental edits over the tracked mask.
- `topics(): number` — the mask last sent.

A reconnected socket starts with an empty server-side mask; `connect()` replays the tracked mask
best-effort (only meaningful if re-auth succeeded).

### Push stream — `client.push` (PushBus)

`client.push` is a framework-free typed emitter. `on(topic, cb)` / `off(topic, cb)` over plain
callbacks (no RxJS). Topic keys and payload types:

| Key | Payload | Fan-out |
|-----|---------|---------|
| `snapshot` | `SensorSnapshot` | |
| `stats` | `Stats` | `StatsFast` deltas are joined onto the last full `Stats` before emit |
| `log` | `LogEntry` | one emit per entry in a `LogBatch` |
| `owScan` / `mbScan` | `OwScanState` / `MbScanState` | |
| `ota` | `OtaProgress` | |
| `ioValue` | `IoValue` | one emit per entry in an `IoValues` batch |
| `ioStruct` | `IoStruct` | register/unregister events |
| `growConfig` | `GrowConfig` | |
| `zbSpectrum` | `ZbSpectrumFrame` | |
| `ctrlEvent` / `ctrlGraphChanged` / `ctrlOutVals` | controller pushes | |
| `timeStatus` | `TimeStatus` | |
| `canObserve` | `CanObserve` | |

Subscribing to the right `Topic.*` bit is still required to make the device emit; `PushBus` only
routes what arrives.

### Lifecycle events

`client.on(event, cb)` / `off`. Events: `connected`, `disconnected`, `authed`, `authExpired`,
`staleClient`, `error`. These replace the SPA's `connected$`/`authed$` observables.

## Typed command builders — `commands.*`

`import { commands } from '@avatarsd-llc/strawberry-client'` (or `import * as commands from
'.../api/commands.js'`). Thin 1:1-with-proto builders over `DeviceClient` for the most-used
paths; they accept `PartialMessage` and fill proto defaults, so callers supply only meaningful
fields. `DeviceClient.send` remains the escape hatch for any of the 64 variants not wrapped here.

| Builder | Wraps |
|---------|-------|
| `growUnitSet(c, unit, timeoutMs?)` | `GrowUnitSet` |
| `growUnitRemove(c, id, timeoutMs?)` | `GrowUnitRemove` |
| `growScheduleSet(c, { id, params, stages, derivedMask? })` | `GrowScheduleSet` |
| `growUserIoAdd(c, unitId, desc, scope?)` | `GrowUserIoAdd` |
| `growUserIoRemove(c, unitId, name)` | `GrowUserIoRemove` |
| `ctrlGraphApply(c, nodes, timeoutMs?)` | `CtrlGraphApply` (atomic, rollback-safe, idempotent re-bind) |
| `ctrlDestroy(c, instanceId)` | `ControllerDestroy` |
| `listControllers(c)` | `ControllerListReq` -> `ControllerList` |
| `getGrowConfig(c)` | `Query{WHAT_GROW_CONFIG}` -> `GrowConfig` |
| `otaBegin(c, { size, target, spaSize?, appSize? })` | `OtaUploadBegin` -> start offset (handles the chunk-ack begin reply) |
| `otaChunk(c, offset, data, timeoutMs?)` | one raw chunk -> next offset |
| `otaEnd(c, timeoutMs?)` / `otaAbort(c)` | `OtaUploadEnd` / `OtaUploadAbort` |

OTA target constants: `OTA_TARGET_APP = 0`, `OTA_TARGET_SPA = 1`, `OTA_TARGET_COMBINED = 2`.

## Seams (the libtracer-ready architecture)

`DeviceClient` depends only on these three interfaces, so the wire format, socket, and token
storage are all swappable.

### Transport (byte pipe)

```ts
interface Transport {
  connect(): Promise<void>;
  send(data: Uint8Array): void;
  onMessage(cb: (data: Uint8Array) => void): void;
  onClose(cb: () => void): void;
  isOpen(): boolean;
  close(): void;
}
```

Implementations: `WsTransport` (root — defaults to the global `WebSocket`; pass
`opts.WebSocketImpl` to inject `ws`), `NodeWsTransport` (`./node` — async factory that prefers
the Node 22+ global `WebSocket` and falls back to a dynamically-imported optional `ws`). Frame
framing is in `frameClientMessage` / `frameOtaChunk` (`FRAME_CLIENT_MSG = 0x00`,
`FRAME_OTA_CHUNK = 0x01`). `wsUrlForHost(host)` normalizes a bare host / `host:port` /
`http(s)://` / `ws(s)://` into a `ws(s)://.../ws` URL.

### Codec (proto <-> bytes)

```ts
interface Codec {
  encodeClient(msg: ClientMessage): Uint8Array;
  decodeServer(bytes: Uint8Array): ServerMessage;
}
```

`ProtobufWsCodec` is the default (the canonical protobuf-ts `ClientMessage`/`ServerMessage`
types). `DeviceClient` exchanges only decoded objects with the codec, so a TLV codec drops in
with no change to the client, the builders, or any consumer.

### TokenStore (HMAC token persistence)

```ts
interface TokenStore {
  get(): string | null;
  set(token: string): void;
  clear(): void;
}
```

Implementations: `MemoryTokenStore` (default), `LocalStorageTokenStore` (browser, key
`strawberry.token`), `FileTokenStore` (`./node`, written mode `0600`).

## HMAC primitive

`hmacSha256Password(password: string, nonce: Uint8Array): Promise<Uint8Array>` — the HMAC
client primitive. The password is the HMAC key (UTF-8 bytes), the nonce the message; returns the
32-byte digest. It is a **pure-JS** HMAC-SHA256 (not `crypto.subtle`) because the device is
served over plain HTTP where `crypto.subtle` is `undefined` in a browser. The async signature is
kept for a possible future secure-context swap. Pinned vector:

    hmacSha256Password("strawberry", 0x00..0x0f) =
      880e5c19ec51b5646794e768dd50f6ec6f7961b9de89dd79852d00d7482bfaed
