# Strawberry WebSocket protocol reference

The wire contract for the Strawberry (Gorshok-v4) grow controller's `/ws` endpoint:
a protobuf-over-WebSocket request/reply + pub/sub protocol. This is the self-contained
reference for anyone implementing or driving a client; the counts are taken from the
generated codec (`src/proto/messages.ts`), not from prose — when a comment and the codec
disagree, the codec wins.

The same `messages.proto` schema backs this library, the firmware's web-ui SPA, and the
Pulumi deploy provider. See [`library.md`](./library.md) for the `DeviceClient` API that
implements everything below, and [`cli.md`](../../strawberry-cli/docs/cli.md) for the `strawberry` CLI over it.

## Transport and framing

- The endpoint is `ws://<host>/ws` (plain `ws`, not `wss` — the 4 MB board serves over
  plain HTTP; there is no TLS). `wss://` works if you front the device with a proxy.
- **Client to server** frames are prefixed with a 1-byte discriminator the firmware uses to
  pick its decoder:
  - `0x00` — a `ClientMessage` protobuf body (the control-plane path).
  - `0x01` — a raw OTA chunk: `0x01 || uint32-LE offset || raw bytes` (no protobuf).
- **Server to client** frames are a bare `ServerMessage` protobuf with **no** discriminator.

See `src/wire/framing.ts` (`frameClientMessage`, `frameOtaChunk`).

## Request/reply correlation

Both `ClientMessage` and `ServerMessage` carry a `request_id` (rid) header alongside a
`oneof payload`.

- A client sets `request_id` to a nonzero, monotonically increasing value per request. The
  server echoes that rid on the matching reply.
- `request_id == 0` on a `ServerMessage` means an **unsolicited push** (a topic frame) — it
  does not correlate to any request.
- The single exception is the **OTA chunk ack**: a raw `0x01` chunk frame carries no rid, so
  the firmware replies with an `OtaChunkAck` at `request_id == 0`. Because only one chunk is
  in flight at a time, the rid-0 ack is unambiguous (offsets order the stream).

This is the one invariant any alternate transport (e.g. a future TLV codec) must preserve:
rid echo, with rid 0 meaning push.

## Surface counts (codec truth)

| Element | Count | Notes |
|---------|-------|-------|
| `ClientMessage` commands (oneof payload, excl. `request_id`) | **64** | non-contiguous tags 10..83 |
| `ServerMessage` types (oneof payload, excl. `request_id`) | **38** | tags 10..51 |
| `Query.What` members (incl. `WHAT_NONE`) | **17** | values `0`..`16`; 16 substantive |
| `Topic` members (incl. `TOPIC_NONE`) | **13** | `0` sentinel + 12 subscribable bit-flag streams |

Do not hard-code a literal command list in a consumer — enumerate from the codec's
`ClientMessage` / `ServerMessage` `oneofKind` unions. The TS enums drop the proto prefix:
`Topic.STATS` (not `TOPIC_STATS`), `Query_What.WIFI` (not `WHAT_WIFI`).

## Topics (13 codec members; 12 subscribable streams)

`Topic` is a **bit field**: a `Subscribe.topics` value is the OR of the flags below.
`TOPIC_NONE` (`0`) is the unsubscribe/sentinel value — subscribing to it clears the session
mask. Subscriptions are per-socket: a reconnected socket starts with an empty mask and must
re-subscribe.

| Flag | Value | Push payload | Notes |
|------|-------|--------------|-------|
| `TOPIC_NONE` | `0x000` | — | sentinel / unsubscribe-all; not a stream |
| `TOPIC_SNAPSHOT` | `0x001` | `SensorSnapshot` | broadcast; see push-only note below |
| `TOPIC_LOG` | `0x002` | `LogBatch` | device log lines (fan out one `LogEntry` per entry) |
| `TOPIC_STATS` | `0x004` | `Stats` / `StatsFast` | push-only; **not** query-answerable |
| `TOPIC_OW_SCAN` | `0x008` | `OwScanState` | 1-Wire bus scan progress |
| `TOPIC_MB_SCAN` | `0x010` | `MbScanState` | Modbus soil-probe scan progress |
| `TOPIC_OTA` | `0x020` | `OtaProgress` | OTA phase/percent |
| `TOPIC_IO` | `0x040` | `IoValue` / `IoValues` | per-entry io_layer value deltas |
| `TOPIC_IO_STRUCT` | `0x080` | `IoStruct` | register/unregister; on subscribe the server replays REGISTERED for every existing entry, then live events |
| `TOPIC_TIME` | `0x100` | `TimeStatus` | ~1 Hz device wall-clock while >=1 session subscribes |
| `TOPIC_ZB_SPECTRUM` | `0x200` | `ZbSpectrumFrame` | 802.15.4 energy-detect loop runs only while >=1 session subscribes |
| `TOPIC_CONTROLLERS` | `0x400` | `ControllerEvent` | ADDED/REMOVED on create/destroy; status/flag deltas are **not** pushed (poll `ControllerListReq`) |
| `TOPIC_CAN_OBSERVE` | `0x800` | `CanObserve` | live CAN domain-bus observe; bridge subscribes only while a session watches |

There is **no `TOPIC_GROW`**. The bit at `0x100` formerly reserved for `TOPIC_GROW_DIAG` was
retired and reassigned to `TOPIC_TIME`. Grow/unit/schedule/profile state is pulled with
`Query{WHAT_GROW_CONFIG}` only — see quirk 3.

### StatsFast join

`TOPIC_STATS` emits a full `Stats` frame on subscribe (and on any task-set change), then
compact `StatsFast` delta frames. A `StatsFast` packs each task's
`(cpu_permille << 16) | stack_hwm_words` positionally against the last full `Stats.tasks`
array; a client materializes it back into a full `Stats` before use. This library does that
join internally in `PushBus`, so every `stats` consumer sees a coherent `Stats` and needs no
`StatsFast` awareness.

## Query.What (17 members; 16 substantive)

One-shot pulls via `Query{what}`. `WHAT_NONE = 0` is the sentinel.

| What | Value | Reply | Answerable? |
|------|-------|-------|-------------|
| `WHAT_NONE` | 0 | — | sentinel |
| `WHAT_SNAPSHOT` | 1 | broadcasts `SensorSnapshot` to subscribers + replies `Ack` | special — see quirk 2 |
| `WHAT_STATS` | 2 | — | **NO** — returns `error 400 "unknown query"`; subscribe `TOPIC_STATS` |
| `WHAT_OW_SENSORS` | 3 | `OwSensors` | yes |
| `WHAT_SOIL` | 4 | `SoilProbes` | yes |
| `WHAT_WIFI` | 5 | `WifiState` | yes |
| `WHAT_HA` | 6 | `HaConfig` | yes |
| `WHAT_OTA` | 7 | `OtaProgress` | yes |
| `WHAT_DEVICE_LIST` | 8 | `DeviceList` | yes |
| `WHAT_DEVICE_CONFIG` | 9 | `DeviceConfig` | yes |
| `WHAT_TIME` | 10 | `TimeStatus` | yes |
| `WHAT_GROW_CONFIG` | 11 | `GrowConfig` | yes (the only way to read grow state) |
| `WHAT_SYSTEM_FLAGS` | 12 | `SystemFlags` | yes |
| `WHAT_WIREGUARD` | 13 | `WgConfig` (stored config, no secret) | yes |
| `WHAT_WG_STATUS` | 14 | `WgStatus` (live tunnel state) | yes |
| `WHAT_CAPABILITIES` | 15 | `Capabilities` | yes |
| `WHAT_OW_CONFIG` | 16 | `OwConfig` (1-Wire IO board channels, DS2450/DS2423) | yes |

`WHAT_STATS` is enumerated in the codec but has no dispatch case, so it falls through to
`error 400 "unknown query"`. The CLI's `query` verb intentionally omits `stats` and
`snapshot` for this reason.

## ClientMessage commands (64)

64 oneof payload arms, non-contiguous tags `10` (`AuthLogin`) .. `83` (`ControlBoxSet`). The
families (by tag):

- **Auth** — `AuthLogin` (10), `AuthResume` (27), `AuthRevoke` (28), `AuthChallengeReq` (80)
- **Subscribe / Query** — `Subscribe` (11), `Query` (26)
- **Config / system** — `ConfigSet` (15), `MpcAuxSet` (36), `SystemFlagsSet` (63),
  `FactoryReset` (48), `Reboot` (25), `WifiSet` (22), `HaSet` (23), `WgSet` (74)
- **1-Wire** — `OwScanStart` (16), `OwSensorMod` (17), `OwConfigSet` (81)
- **Modbus** — `MbScanStart` (18), `MbProbeMod` (19), `MbSetAddress` (20)
- **OTA** — `OtaStart` (21), `OtaUploadBegin` (38), `OtaUploadEnd` (40), `OtaUploadAbort` (41)
- **Device registry** — `DeviceListReq` (30), `DeviceAdd` (31), `DeviceRemove` (32),
  `DeviceSetCfg` (33), `DeviceScan` (34), `DeviceScanStop` (35)
- **IO substrate** — `IoSet` (29), `IoPersistSet` (37), `IoMqttSet` (70), `IoCanSet` (76),
  `CanRxBind` (77), `CanRxUnbind` (78)
- **Grow** — `GrowUnitSet` (42), `GrowUnitRemove` (43), `GrowProfileSet` (44),
  `GrowProfileRemove` (45), `GrowStageAdvance` (46), `GrowUserIoAdd` (66),
  `GrowUserIoRemove` (67), `GrowUserIoListReq` (68), `GrowScheduleSet` (69),
  `GrowEraseSettings` (72)
- **Controllers** — `ControllerListReq` (56), `ControllerSetEnabled` (57),
  `ControllerSetTarget` (58), `ControllerDestroy` (59), `ControllerCreate` (60),
  `ControllerBind` (64), `ControllerSetParams` (65), `ControllerAcknowledge` (73),
  `CtrlGraphApply` (75)
- **Zigbee** — `ZigbeeFactoryReset` (49), `ZbSetPollInterval` (51),
  `ZbPermitJoinKeepOpen` (52), `ZbSetPollingEnabled` (53), `ZbDpSelectSet` (54),
  `ZbDpCatalogReq` (55)
- **Misc** — `SdInfoReq` (79), `ControlBoxGet` (82), `ControlBoxSet` (83)

## ServerMessage types (38)

38 oneof reply arms, tags `10` (`SensorSnapshot`) .. `51` (`ControlBoxBlob`). They split into:

- **request/reply** — matched to a `request_id` (e.g. `Ack`, `ErrorMsg`, `AuthOk`,
  `AuthChallenge`, `WifiState`, `GrowConfig`, `ControllerList`, `OwConfig`, `OtaChunkAck`, ...).
- **unsolicited push** — matched to a `Topic` subscription (the per-topic payloads in the
  Topics table: `SensorSnapshot`, `Stats`/`StatsFast`, `LogBatch`, `IoValue(s)`, `IoStruct`,
  `OtaProgress`, scans, `TimeStatus`, `ZbSpectrumFrame`, `ControllerEvent`, `CanObserve`, ...).

`Ack` carries `{ ok, detail }`; a failed command may reply with `Ack{ok:false}` **or** with
`ErrorMsg{code, detail}` depending on the path — a robust client handles both.

## Authentication — HMAC challenge-response

The plaintext password never crosses the wire. The flow:

1. `AuthChallengeReq{}` -> `AuthChallenge{nonce}` (a single-use server nonce).
2. The client computes `HMAC-SHA256(password, nonce)` — the **password is the HMAC key**
   (its UTF-8 bytes), the **nonce is the message** — and sends `AuthLogin{hmac, desiredTtlMs}`
   with `password: ""`. The digest is the only secret-derived value on the wire.
3. `AuthOk{token, ttlMs, serverNowMs}` on success; the firmware recomputes the HMAC from its
   NVS password + nonce and constant-time compares.

The HMAC must be **pure-JS** (not `crypto.subtle`): the device is served over plain HTTP,
and `crypto.subtle` is `undefined` in a browser non-secure context. This library ships a
self-contained pure-JS HMAC-SHA256 (`src/auth/hmac.ts`). Pinned cross-implementation vector,
shared with the firmware's `ws_hmac.c`:

    HMAC-SHA256("strawberry", 0x00..0x0f) =
      880e5c19ec51b5646794e768dd50f6ec6f7961b9de89dd79852d00d7482bfaed

`desiredTtlMs` is clamped server-side: `0` maps to the default 24 h, floored at 60 s, capped
at 7 d. `serverNowMs` is meant to map monotonic push `ts_ms` to wall-clock via
`bootOffsetMs = Date.now() - serverNowMs`; on current firmware `serverNowMs` is reported as
`0`, so the derived offset is unreliable (treat push timestamps as monotonic-since-boot).

Token lifecycle messages: `AuthResume{token}` -> `AuthOk` (or `ErrorMsg{ERR_AUTH_EXPIRED}`),
and `AuthRevoke{token}` -> `Ack`.

## OTA upload (push, targets 0/1/2)

A firmware/web-UI push is: `OtaUploadBegin` -> a stream of raw `0x01` chunk frames -> `OtaUploadEnd`.

- `OtaUploadBegin{size, target, spaSize?, appSize?}`. Targets: `0` app slot, `1` spa partition
  (web UI), `2` combined `[spa][app]` stream. The **begin reply is an `OtaChunkAck{nextOffset:0}`**
  carrying the request rid — not an `Ack`.
- Each raw chunk frame (`0x01 || uint32-LE offset || bytes`, ≤4096 payload to match the
  firmware's `OTA_CHUNK_MAX`) is answered by an `OtaChunkAck{nextOffset}` at rid 0. Send one
  chunk, await its ack, send the next at `nextOffset`.
- `OtaUploadEnd{}` -> `Ack`, then the device applies. For app/combined targets the **reboot
  drops the socket before the End ack lands** — treat the dropped socket as success and verify
  afterward (`query ota`, `diag heap`).
- The combined image is a `tools/mk_combined.py` stream: a 12-byte header
  `magic('SBC1' LE 0x31434253) || uint32-LE appSize || uint32-LE spaSize` followed by
  `[spa][app]`. Chunk offsets are payload-relative (the header is not streamed).

## Firmware quirks every client MUST know

These are HIL-discovered behaviours of the ESP-IDF/lwIP WS server, not in the `.proto`.

### 1. Auth tokens are socket-bound — resume is single-connection only

The auth-token slot is **bound to the socket that issued it and revoked when that socket
closes** (the fix that plugged an 8-slot token leak). Consequence: **a token issued on one
socket and replayed via `AuthResume` on a new socket returns `ERR_AUTH_EXPIRED` (419,
"token expired")** — the slot was revoked when the first socket closed. So cross-process /
CLI token persistence cannot resume a session; each fresh socket needs a fresh
`AuthChallengeReq` -> `AuthLogin`. `AuthResume` only helps a reconnect on a logical client
whose slot is still alive (which it is not after a close on current firmware). The slot table
holds at most 8 tokens.

### 2. Stats and Snapshot are push-only — subscribe, don't query

- `WHAT_STATS` is not answerable (`error 400 "unknown query"`). Subscribe `TOPIC_STATS` and
  read `Stats` / `StatsFast` pushes (~1 Hz).
- `WHAT_SNAPSHOT` *is* dispatched, but the query triggers a broadcast to `TOPIC_SNAPSHOT`
  subscribers and replies only an `Ack` to the caller. To receive snapshot data you must be
  subscribed to `TOPIC_SNAPSHOT`; the query is just a "refresh now" trigger.

Net rule: for live telemetry (Stats, Snapshot, IO, logs, scans, OTA, time, spectrum, CAN)
**subscribe to the topic**; do not expect a request/reply.

### 3. grow_config is query-only — there is no TOPIC_GROW

Grow/unit/schedule/profile/facet state is read **only** via `Query{WHAT_GROW_CONFIG}` ->
`GrowConfig`. There is no grow push topic, so grow mutations are not broadcast — a second
client sees stale grow state until it re-queries `WHAT_GROW_CONFIG` after any grow mutation
(its own or a peer's). User-endpoints, controller nodes, and OW/MB scans *do* push (via
`TOPIC_IO_STRUCT` / `TOPIC_CONTROLLERS` / scan topics).

### 4. GrowUserIoAdd timing / unit materialization

The firmware only materializes (registers io endpoints + controllers for) **active** units.
`GrowUserIoAdd` to an inactive or just-created unit can return `ERR_NOT_FOUND` — a
materialization race. Create the unit **active**, and retry/await materialization before
adding user IO. (The CLI's `grow unit-set` defaults a unit to active for exactly this reason.)

### 5. Single-client friendliness

The C6 httpd is happiest with **≤2 concurrent WS clients**; more can wedge the server. Drivers
(CLI, agents) should keep to one connection.

## Error codes

- `ERR_AUTH_EXPIRED = 419` — token revoked or expired; re-login.
- `400` (`"unknown query"` / `"unknown frame kind"`) — sent as the wire error code on the
  unknown-query / bad-frame paths (not an `ErrCode` enum member).
- `ERR_NOT_FOUND = 404` — e.g. `GrowUserIoAdd` to an unmaterialized unit (quirk 4).
- `ERR_STALE_CLIENT` — the firmware tells a client its view is stale and it should reload;
  this library surfaces it as a `staleClient` event.
