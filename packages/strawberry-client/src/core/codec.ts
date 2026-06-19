/**
 * Codec seam (ADR-0066 D2/D11).
 *
 * DeviceClient never imports the protobuf codec directly; it exchanges decoded
 * `ClientMessage`/`ServerMessage` objects with a `Codec` and lets the codec own
 * the proto<->bytes translation. That keeps the core wire-format-agnostic: a
 * libtracer (TLV) codec can drop in later with no change to DeviceClient.
 *
 * `ProtobufWsCodec` is the default implementation backed by the canonical
 * protobuf-ts MessageType instances.
 */
import { ClientMessage, ServerMessage } from '../proto/messages.js';

/** proto<->bytes translation seam. */
export interface Codec {
  encodeClient(msg: ClientMessage): Uint8Array;
  decodeServer(bytes: Uint8Array): ServerMessage;
}

/** Default codec: the canonical protobuf-ts ClientMessage/ServerMessage types. */
export class ProtobufWsCodec implements Codec {
  encodeClient(msg: ClientMessage): Uint8Array {
    return ClientMessage.toBinary(msg);
  }
  decodeServer(bytes: Uint8Array): ServerMessage {
    return ServerMessage.fromBinary(bytes);
  }
}
