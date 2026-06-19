import { describe, it, expect, beforeEach } from 'vitest';
import { DeviceClient } from '../src/core/device-client.js';
import { ProtobufWsCodec } from '../src/core/codec.js';
import { MemoryTokenStore } from '../src/core/token-store.js';
import type { Transport } from '../src/wire/transport.js';
import { FRAME_CLIENT_MSG, FRAME_OTA_CHUNK } from '../src/wire/framing.js';
import {
  ClientMessage,
  ServerMessage,
  Query_What,
  type Stats,
  type StatsFast,
} from '../src/proto/messages.js';

const codec = new ProtobufWsCodec();

/**
 * A scriptable transport: decodes each outbound ClientMessage frame, lets the
 * test produce the matching ServerMessage(s), and feeds them back through
 * onMessage so DeviceClient's dispatch runs exactly as it would over a real WS.
 */
class MockTransport implements Transport {
  private msgCb: ((d: Uint8Array) => void) | null = null;
  private closeCb: (() => void) | null = null;
  open = false;
  /** Per-oneofKind responder. Returns ServerMessage(s) to deliver, rid auto-set. */
  responders = new Map<string, (rid: number, payload: ClientMessage['payload']) => ServerMessage[]>();
  /** Captured raw OTA chunk frames. */
  chunks: Uint8Array[] = [];
  /** Optional responder for raw chunk frames. */
  onChunk: ((offset: number, body: Uint8Array) => ServerMessage[]) | null = null;

  connect(): Promise<void> { this.open = true; return Promise.resolve(); }
  isOpen(): boolean { return this.open; }
  onMessage(cb: (d: Uint8Array) => void): void { this.msgCb = cb; }
  onClose(cb: () => void): void { this.closeCb = cb; }
  close(): void { this.open = false; this.closeCb?.(); }

  send(data: Uint8Array): void {
    if (data[0] === FRAME_OTA_CHUNK) {
      this.chunks.push(data);
      const offset = data[1] | (data[2] << 8) | (data[3] << 16) | (data[4] << 24);
      const replies = this.onChunk?.(offset >>> 0, data.slice(5)) ?? [];
      for (const r of replies) this.deliver(r);
      return;
    }
    if (data[0] !== FRAME_CLIENT_MSG) throw new Error('bad discriminator');
    const msg = ClientMessage.fromBinary(data.slice(1));
    const responder = this.responders.get(msg.payload.oneofKind);
    if (!responder) return; // no reply scripted -> request will time out
    for (const r of responder(msg.requestId, msg.payload)) this.deliver(r);
  }

  /** Feed a ServerMessage back to the client as wire bytes (async, mimics network). */
  deliver(msg: ServerMessage): void {
    const bytes = ServerMessage.toBinary(msg);
    queueMicrotask(() => this.msgCb?.(bytes));
  }

  /** Push an unsolicited frame (rid=0 push topic), synchronously. */
  pushFrame(msg: ServerMessage): void {
    this.msgCb?.(ServerMessage.toBinary(msg));
  }
}

function ack(rid: number, ok = true): ServerMessage {
  return { requestId: rid, payload: { oneofKind: 'ack', ack: { ok, detail: ok ? '' : 'nack', code: 0 } } };
}

describe('DeviceClient — request/reply, auth, push', () => {
  let t: MockTransport;
  let client: DeviceClient;

  beforeEach(() => {
    t = new MockTransport();
    client = new DeviceClient({ transport: t, codec, tokenStore: new MemoryTokenStore() });
  });

  it('matches a reply to its request by rid (concurrent mode)', async () => {
    t.responders.set('query', (rid) => [{
      requestId: rid,
      payload: { oneofKind: 'stats', stats: makeStats() },
    }]);
    await client.connect();
    const reply = await client.query<'stats'>(Query_What.STATS);
    expect(reply.oneofKind).toBe('stats');
  });

  it('runs the full SEC-001 login handshake (challenge -> hmac -> authOk)', async () => {
    const nonce = new Uint8Array(Array.from({ length: 16 }, (_, i) => i));
    let loginHmacLen = -1;
    let plaintextSent: string | null = null;
    t.responders.set('authChallengeReq', (rid) => [{
      requestId: rid, payload: { oneofKind: 'authChallenge', authChallenge: { nonce } },
    }]);
    t.responders.set('login', (rid, payload) => {
      if (payload.oneofKind === 'login') {
        loginHmacLen = payload.login.hmac.length;
        plaintextSent = payload.login.password;
      }
      return [{
        requestId: rid,
        payload: { oneofKind: 'authOk', authOk: { token: 'tok-123', ttlMs: 60000, serverNowMs: '5000' } },
      }];
    });
    await client.connect();
    await client.login('strawberry');
    expect(client.isAuthed()).toBe(true);
    expect(client.hasToken()).toBe(true);
    // The plaintext password NEVER crosses the wire — only the 32-byte HMAC.
    expect(plaintextSent).toBe('');
    expect(loginHmacLen).toBe(32);
    // bootOffsetMs computed from serverNowMs.
    expect(typeof client.bootOffsetMs()).toBe('number');
  });

  it('throws on a nacked Ack via sendExpectAck', async () => {
    t.responders.set('reboot', (rid) => [ack(rid, false)]);
    await client.connect();
    await expect(client.sendExpectAck({ oneofKind: 'reboot', reboot: { delayMs: 0 } })).rejects.toThrow('nack');
  });

  it('serializes sends in sequential mode (one in flight)', async () => {
    const seq = new DeviceClient({ transport: t, codec, requestMode: 'sequential' });
    const order: number[] = [];
    t.responders.set('query', (rid) => { order.push(rid); return [ack(rid)]; });
    await seq.connect();
    await Promise.all([
      seq.send({ oneofKind: 'query', query: { what: Query_What.STATS } }),
      seq.send({ oneofKind: 'query', query: { what: Query_What.WIFI } }),
      seq.send({ oneofKind: 'query', query: { what: Query_What.HA } }),
    ]);
    // rids are assigned in send order; sequential mode keeps them monotonic.
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(order.length).toBe(3);
  });

  it('joins a StatsFast push onto the last full Stats and emits a coherent Stats', async () => {
    await client.connect();
    const got: Stats[] = [];
    client.push.on('stats', (s) => got.push(s));
    // First a full frame (the name/static reference).
    t.pushFrame({ requestId: 0, payload: { oneofKind: 'stats', stats: makeStats() } });
    // Then a compact StatsFast: task[0] packs (cpu_permille<<16)|hwm.
    const fast: StatsFast = {
      task: [(250 << 16) | 1234],
      freeHeap: 40000, minFreeHeap: 30000, largestFreeBlock: 20000,
      cpuPercentTotal: 42, rssi: -55, uptimeMs: '9999',
    };
    t.pushFrame({ requestId: 0, payload: { oneofKind: 'statsFast', statsFast: fast } });
    expect(got.length).toBe(2);
    const joined = got[1];
    expect(joined.freeHeap).toBe(40000);
    expect(joined.tasks[0].cpuPermille).toBe(250);
    expect(joined.tasks[0].stackHighWm).toBe(1234);
    // Static metadata (task name) survives from the full reference frame.
    expect(joined.tasks[0].name).toBe('main');
  });

  it('fans out an ioValues batch into per-entry ioValue events', async () => {
    await client.connect();
    const ids: string[] = [];
    client.push.on('ioValue', (v) => ids.push(v.id));
    t.pushFrame({
      requestId: 0,
      payload: {
        oneofKind: 'ioValues',
        ioValues: {
          values: [
            ioVal('a', 1),
            ioVal('b', 2),
          ],
        },
      },
    });
    expect(ids).toEqual(['a', 'b']);
  });

  it('drives an OTA chunk and resolves the next offset (rid=0 OtaChunkAck)', async () => {
    await client.connect();
    t.onChunk = (offset, body) => [{
      requestId: 0,
      payload: { oneofKind: 'otaChunkAck', otaChunkAck: { nextOffset: offset + body.length } },
    }];
    const next = await client.sendChunkRaw(0, new Uint8Array([1, 2, 3, 4]));
    expect(next).toBe(4);
    expect(t.chunks.length).toBe(1);
  });

  it('tracks the local topic mirror across add/remove', async () => {
    t.responders.set('subscribe', (rid) => [ack(rid)]);
    await client.connect();
    await client.subscribe(0b0001);
    expect(client.topics()).toBe(0b0001);
    await client.addTopics(0b0100);
    expect(client.topics()).toBe(0b0101);
    await client.removeTopics(0b0001);
    expect(client.topics()).toBe(0b0100);
  });
});

function makeStats(): Stats {
  return {
    freeHeap: 50000, minFreeHeap: 40000, largestFreeBlock: 30000,
    cpuPercentTotal: 10, rssi: -50, uptimeMs: '1000',
    tasks: [
      { name: 'main', cpuPermille: 100, cpuPercent: 10, stackHighWm: 512, priority: 5, stackSize: 4096 },
    ],
  } as Stats;
}

function ioVal(id: string, v: number): import('../src/proto/messages.js').IoValue {
  return { id, valid: true, dtype: 3, vBool: false, vI32: 0, vU32: 0, vF32: v, tsMs: '0', vStr: '' };
}
