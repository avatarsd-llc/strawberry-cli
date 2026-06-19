import { describe, it, expect } from 'vitest';
import { ProtobufWsCodec } from '../src/core/codec.js';
import { ClientMessage, ServerMessage, Query_What } from '../src/proto/messages.js';

describe('ProtobufWsCodec — canonical protobuf-ts roundtrip', () => {
  const codec = new ProtobufWsCodec();

  it('roundtrips a ClientMessage Query through encode/decode', () => {
    const msg: ClientMessage = { requestId: 7, payload: { oneofKind: 'query', query: { what: Query_What.STATS } } };
    const bytes = codec.encodeClient(msg);
    expect(bytes).toBeInstanceOf(Uint8Array);
    const back = ClientMessage.fromBinary(bytes);
    expect(back.requestId).toBe(7);
    expect(back.payload.oneofKind).toBe('query');
    if (back.payload.oneofKind === 'query') expect(back.payload.query.what).toBe(Query_What.STATS);
  });

  it('decodes a ServerMessage Ack the codec encoded', () => {
    const ack: ServerMessage = {
      requestId: 11,
      payload: { oneofKind: 'ack', ack: { ok: true, detail: 'done', code: 0 } },
    };
    const wire = ServerMessage.toBinary(ack);
    const decoded = codec.decodeServer(wire);
    expect(decoded.requestId).toBe(11);
    expect(decoded.payload.oneofKind).toBe('ack');
    if (decoded.payload.oneofKind === 'ack') {
      expect(decoded.payload.ack.ok).toBe(true);
      expect(decoded.payload.ack.detail).toBe('done');
    }
  });

  it('preserves the AuthLogin hmac bytes across the wire (SEC-001)', () => {
    const hmac = new Uint8Array(Array.from({ length: 32 }, (_, i) => (i * 7) & 0xff));
    const msg: ClientMessage = {
      requestId: 1,
      payload: { oneofKind: 'login', login: { password: '', desiredTtlMs: 0, hmac } },
    };
    const back = ClientMessage.fromBinary(codec.encodeClient(msg));
    expect(back.payload.oneofKind).toBe('login');
    if (back.payload.oneofKind === 'login') expect(Array.from(back.payload.login.hmac)).toEqual(Array.from(hmac));
  });
});
