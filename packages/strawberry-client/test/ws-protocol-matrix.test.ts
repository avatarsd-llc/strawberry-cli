/**
 * WS PROTOCOL COVERAGE MATRIX
 *
 * "100% coverage of the existing WebSocket": one assertion per protocol element.
 * Data-driven over the generated codec's reflection, so it is exhaustive by
 * construction AND self-guarding — if the firmware proto grows a command, the
 * count assertions fail until this matrix is updated.
 *
 *   - every ClientMessage command round-trips through the codec (encode->decode)
 *   - every ServerMessage type round-trips
 *   - every Query.What and Topic enum value is present
 *
 * The hardware half (each command exercised against a live board) lives in
 * scripts/hil-matrix.mjs; this file is the wire/codec half.
 */
import { describe, it, expect } from 'vitest';
import {
  ClientMessage, ServerMessage, Query_What, Topic,
} from '../src/proto/messages.js';

type IField = { oneof?: string; localName: string };
function payloadVariants(MT: { fields: IField[] }): string[] {
  return MT.fields.filter((f) => f.oneof === 'payload').map((f) => f.localName);
}

const CM_VARIANTS = payloadVariants(ClientMessage as unknown as { fields: IField[] });
const SM_VARIANTS = payloadVariants(ServerMessage as unknown as { fields: IField[] });

// Authoritative counts (components/proto/messages.proto). Bump deliberately when
// the firmware adds a command — that is the signal this matrix needs a new row.
const EXPECTED = { clientCmds: 64, serverMsgs: 38, queries: 17, topics: 13 };

describe('WS protocol matrix — completeness', () => {
  it('sees every ClientMessage command', () => {
    expect(CM_VARIANTS.length).toBe(EXPECTED.clientCmds);
  });
  it('sees every ServerMessage type', () => {
    expect(SM_VARIANTS.length).toBe(EXPECTED.serverMsgs);
  });
  it('sees every Query.What member', () => {
    // numeric enum members only (drop the reverse string map)
    const vals = Object.values(Query_What).filter((v) => typeof v === 'number') as number[];
    expect(vals.length).toBe(EXPECTED.queries);
  });
  it('sees every Topic member', () => {
    const vals = Object.values(Topic).filter((v) => typeof v === 'number') as number[];
    expect(vals.length).toBe(EXPECTED.topics);
  });
});

describe('WS protocol matrix — ClientMessage round-trip (all 64 commands)', () => {
  it.each(CM_VARIANTS)('cmd %s encodes and decodes', (name) => {
    const msg = ClientMessage.create({
      requestId: 4242,
      payload: { oneofKind: name, [name]: {} },
    } as unknown as Parameters<typeof ClientMessage.create>[0]);
    const bytes = ClientMessage.toBinary(msg);
    const back = ClientMessage.fromBinary(bytes);
    expect(back.payload.oneofKind).toBe(name);
    expect(back.requestId).toBe(4242);
  });
});

describe('WS protocol matrix — ServerMessage round-trip (all 38 types)', () => {
  it.each(SM_VARIANTS)('reply %s encodes and decodes', (name) => {
    const msg = ServerMessage.create({
      requestId: 99,
      payload: { oneofKind: name, [name]: {} },
    } as unknown as Parameters<typeof ServerMessage.create>[0]);
    const bytes = ServerMessage.toBinary(msg);
    const back = ServerMessage.fromBinary(bytes);
    expect(back.payload.oneofKind).toBe(name);
    expect(back.requestId).toBe(99);
  });
});
