import { describe, it, expect } from 'vitest';
import {
  frameClientMessage,
  frameOtaChunk,
  FRAME_CLIENT_MSG,
  FRAME_OTA_CHUNK,
} from '../src/wire/framing.js';

describe('wire framing — 0x00 client message / 0x01 raw OTA chunk', () => {
  it('prefixes a client message with 0x00', () => {
    const body = new Uint8Array([1, 2, 3]);
    const f = frameClientMessage(body);
    expect(f[0]).toBe(FRAME_CLIENT_MSG);
    expect(Array.from(f.slice(1))).toEqual([1, 2, 3]);
    expect(f.length).toBe(4);
  });

  it('lays out an OTA chunk as 0x01 || uint32-LE offset || bytes', () => {
    const data = new Uint8Array([0xaa, 0xbb]);
    const f = frameOtaChunk(0x01020304, data);
    expect(f[0]).toBe(FRAME_OTA_CHUNK);
    // little-endian offset
    expect(Array.from(f.slice(1, 5))).toEqual([0x04, 0x03, 0x02, 0x01]);
    expect(Array.from(f.slice(5))).toEqual([0xaa, 0xbb]);
  });

  it('handles offset 0 and an empty chunk', () => {
    const f = frameOtaChunk(0, new Uint8Array(0));
    expect(Array.from(f)).toEqual([FRAME_OTA_CHUNK, 0, 0, 0, 0]);
  });
});
