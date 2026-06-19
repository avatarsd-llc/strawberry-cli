/**
 * WS frame framing (ported from ws.service.ts:377-432).
 *
 * Every client->server frame is prefixed with a 1-byte discriminator the
 * firmware uses to pick its buffer + decoder:
 *   0x00 = a ClientMessage protobuf body (the control-plane path)
 *   0x01 = a raw OTA chunk: 0x01 || uint32-LE offset || raw bytes
 *
 * Server->client frames are bare ServerMessage protobuf (no discriminator).
 */

export const FRAME_CLIENT_MSG = 0x00;
export const FRAME_OTA_CHUNK = 0x01;

/** Prefix an encoded ClientMessage body with the 0x00 discriminator. */
export function frameClientMessage(body: Uint8Array): Uint8Array {
  const out = new Uint8Array(1 + body.length);
  out[0] = FRAME_CLIENT_MSG;
  out.set(body, 1);
  return out;
}

/**
 * Build a raw OTA chunk frame:
 *   byte 0     : 0x01
 *   bytes 1..4 : uint32 LE offset
 *   bytes 5..N : raw firmware bytes
 */
export function frameOtaChunk(offset: number, data: Uint8Array): Uint8Array {
  const frame = new Uint8Array(1 + 4 + data.length);
  frame[0] = FRAME_OTA_CHUNK;
  frame[1] = offset & 0xff;
  frame[2] = (offset >>> 8) & 0xff;
  frame[3] = (offset >>> 16) & 0xff;
  frame[4] = (offset >>> 24) & 0xff;
  frame.set(data, 5);
  return frame;
}
