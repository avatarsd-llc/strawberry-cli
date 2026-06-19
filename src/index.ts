/**
 * `@avatarsd-llc/device-client` — the shared, framework-free Strawberry client.
 *
 * One library, three consumers (ADR-0066 R3): the web-ui SPA, the Pulumi deploy
 * provider, and strawberry-cli. The core is transport- and codec-agnostic
 * (ADR-0066 D11): DeviceClient exchanges decoded ClientMessage/ServerMessage
 * with a { transport, codec } pair and never names a WebSocket, so a libtracer
 * (TLV) codec/transport drops in later.
 *
 * See doc/adr/0066-device-client-extraction-shared-lib.md and
 * doc/device-client-extraction-plan.md.
 */

// --- core ---------------------------------------------------------------------
export { DeviceClient } from './core/device-client.js';
export type {
  DeviceClientOptions,
  RequestMode,
  DeviceClientEvent,
} from './core/device-client.js';
export { PushBus } from './core/push-bus.js';
export type { PushEventMap, PushTopic, PushHandler } from './core/push-bus.js';
export { ProtobufWsCodec } from './core/codec.js';
export type { Codec } from './core/codec.js';
export {
  MemoryTokenStore,
  LocalStorageTokenStore,
  STORAGE_TOKEN_KEY,
} from './core/token-store.js';
export type { TokenStore, StorageLike } from './core/token-store.js';

// --- wire ---------------------------------------------------------------------
export { WsTransport, wsUrlForHost } from './wire/transport.js';
export type { Transport, WsLike, WsImpl, WsTransportOptions } from './wire/transport.js';
export {
  frameClientMessage,
  frameOtaChunk,
  FRAME_CLIENT_MSG,
  FRAME_OTA_CHUNK,
} from './wire/framing.js';

// --- auth ---------------------------------------------------------------------
export { hmacSha256Password } from './auth/hmac.js';

// --- api (typed command/query helpers) ---------------------------------------
export * as commands from './api/commands.js';

// --- proto (the canonical protobuf-ts codec surface) -------------------------
// Re-exports ClientMessage/ServerMessage/Topic/Query_What + every message
// interface, so consumers get the full wire vocabulary from this one entry.
export * from './proto/messages.js';

// --- design (pure, browser-safe blueprints) ----------------------------------
// Also available transport-free via the './design' subpath so the SPA tree-shakes.
export * from './design/index.js';
