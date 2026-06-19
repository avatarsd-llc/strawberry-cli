/**
 * DeviceClient — the framework-free port of ws.service.ts (ADR-0066).
 *
 * Reproduces the proven SPA client logic with zero Angular and zero RxJS:
 *   - request/reply by rid Map (concurrent mode, the SPA default) OR one-in-flight
 *     (sequential mode, for the Pulumi provider / CLI), D4
 *   - the 0x00 ClientMessage / 0x01 raw-OTA-chunk framing (wire/framing.ts)
 *   - SEC-001 HMAC challenge-response login; the plaintext password NEVER hits the
 *     wire — only HMAC-SHA256(password, nonce) (auth/hmac.ts, pure-JS over http)
 *   - AuthResume on reconnect; ERR_AUTH_EXPIRED clears the token
 *   - bootOffsetMs = Date.now() - serverNowMs captured at AuthOk
 *   - typed query<T>(what), subscribe/addTopics/removeTopics with a local mirror
 *   - sendChunkRaw + the rid=0 OtaChunkAck resolver
 *
 * The transport and codec are seams (ADR-0066 D11): DeviceClient never names a
 * WebSocket or the protobuf runtime, so a libtracer (TLV) codec/transport drops
 * in unchanged. Push topics fan out through PushBus; lifecycle is surfaced as
 * plain callbacks/events (no DOM confirm/reload).
 */
import {
  ClientMessage,
  ServerMessage,
  ErrCode,
  Query_What,
  type Ack,
  type AuthOk,
} from '../proto/messages.js';
import { hmacSha256Password } from '../auth/hmac.js';
import { type Transport, WsTransport, wsUrlForHost, type WsTransportOptions } from '../wire/transport.js';
import { frameClientMessage, frameOtaChunk } from '../wire/framing.js';
import { type Codec, ProtobufWsCodec } from './codec.js';
import { type TokenStore, MemoryTokenStore } from './token-store.js';
import { PushBus } from './push-bus.js';

export type RequestMode = 'concurrent' | 'sequential';

/** Lifecycle events, replacing the SPA's connected$/authed$ BehaviorSubjects. */
export type DeviceClientEvent =
  | 'connected'
  | 'disconnected'
  | 'authed'
  | 'authExpired'
  | 'staleClient'
  | 'error';

export interface DeviceClientOptions {
  transport: Transport;
  codec?: Codec;
  /** 'concurrent' (default, rid Map) | 'sequential' (one-in-flight). */
  requestMode?: RequestMode;
  tokenStore?: TokenStore;
  /** Default reply window for send(). Default 8000 ms. */
  requestTimeoutMs?: number;
  /** Auto-reconnect after an unexpected close. Default true. */
  autoReconnect?: boolean;
  /** Fired once when the firmware reports ERR_STALE_CLIENT (UI should reload). */
  onStaleClient?: () => void;
}

/** A pending request carries both settle handles so onClose can reject cleanly. */
interface PendingReply {
  resolve: (m: ServerMessage) => void;
  reject: (e: Error) => void;
}

const DEFAULT_TIMEOUT_MS = 8000;
const CHUNK_TIMEOUT_MS = 15000;
const RECONNECT_MIN_MS = 500;
const RECONNECT_MAX_MS = 15000;

export class DeviceClient {
  readonly push = new PushBus();

  private readonly transport: Transport;
  private readonly codec: Codec;
  private readonly mode: RequestMode;
  private readonly tokenStore: TokenStore;
  private readonly requestTimeoutMs: number;
  private readonly autoReconnect: boolean;
  private readonly onStaleClient?: () => void;

  private nextRid = 1;
  private readonly pending = new Map<number, PendingReply>();
  /** Sequential mode: at most one in-flight; queued sends wait their turn. */
  private seqChain: Promise<unknown> = Promise.resolve();

  private chunkAckResolver: ((nextOffset: number) => void) | null = null;
  private chunkAckRejecter: ((e: Error) => void) | null = null;

  private token: string | null = null;
  private _bootOffsetMs = 0;
  private authed = false;
  private connected = false;
  private wantConnected = false;
  private reconnectMs = RECONNECT_MIN_MS;
  private stalePromptShown = false;
  private currentTopics = 0;

  private readonly listeners = new Map<DeviceClientEvent, Set<(...args: unknown[]) => void>>();

  constructor(opts: DeviceClientOptions) {
    this.transport = opts.transport;
    this.codec = opts.codec ?? new ProtobufWsCodec();
    this.mode = opts.requestMode ?? 'concurrent';
    this.tokenStore = opts.tokenStore ?? new MemoryTokenStore();
    this.requestTimeoutMs = opts.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.autoReconnect = opts.autoReconnect ?? true;
    this.onStaleClient = opts.onStaleClient;
    this.token = this.tokenStore.get();

    this.transport.onMessage((data) => this.onFrame(data));
    this.transport.onClose(() => this.onClose());
  }

  /**
   * Convenience: build a WsTransport for a host (bare host, host:port, or full
   * ws(s):// URL) + the default protobuf codec. In the browser the global
   * WebSocket is used; for Node pass a WebSocketImpl via `wsOpts` or use the
   * `./node` NodeWsTransport directly.
   */
  static forWsHost(host: string, opts: Partial<DeviceClientOptions> & { wsOpts?: WsTransportOptions } = {}): DeviceClient {
    const transport = new WsTransport(wsUrlForHost(host), opts.wsOpts);
    return new DeviceClient({ ...opts, transport });
  }

  /* ------------ event seam (no RxJS) ------------ */

  on(event: DeviceClientEvent, cb: (...args: unknown[]) => void): this {
    let set = this.listeners.get(event);
    if (!set) { set = new Set(); this.listeners.set(event, set); }
    set.add(cb);
    return this;
  }
  off(event: DeviceClientEvent, cb: (...args: unknown[]) => void): this {
    this.listeners.get(event)?.delete(cb);
    return this;
  }
  private fire(event: DeviceClientEvent, ...args: unknown[]): void {
    const set = this.listeners.get(event);
    if (set) for (const cb of set) cb(...args);
  }

  /* ------------ connection ------------ */

  /** Open the transport; if a token is stored, attempt AuthResume immediately. */
  async connect(): Promise<void> {
    this.wantConnected = true;
    await this.transport.connect();
    this.connected = true;
    this.reconnectMs = RECONNECT_MIN_MS;
    this.fire('connected');
    if (this.token) await this.tryResume();
    // A reconnected socket starts with sub_mask=0 server-side (per-fd session), so
    // the previously-set subscription mask is silently dropped unless we replay it.
    // Only meaningful once re-authed — on this firmware AuthResume is per-socket and
    // typically fails after a reconnect (HIL B1), so subscriptions cannot survive a
    // drop without a fresh login; replay is best-effort for the resume-capable case.
    if (this.authed && this.currentTopics) {
      try { await this.sendExpectAck({ oneofKind: 'subscribe', subscribe: { topics: this.currentTopics } }); }
      catch { /* best effort; caller observes 'disconnected'/'authExpired' and re-logs in */ }
    }
  }

  /** Tear down the transport and stop reconnecting. */
  disconnect(): void {
    this.wantConnected = false;
    this.connected = false;
    this.transport.close();
  }

  isConnected(): boolean { return this.connected; }
  isAuthed(): boolean { return this.authed; }
  hasToken(): boolean { return !!this.token; }
  /** Add to a monotonic ts_ms to get a wall-clock timestamp. 0 until AuthOk. */
  bootOffsetMs(): number { return this._bootOffsetMs; }

  private onClose(): void {
    this.connected = false;
    this.authed = false;
    this.fire('disconnected');
    // Reject any in-flight requests so awaiters fail fast instead of waiting out
    // their own per-request timeout (the socket is gone — the reply never comes).
    for (const [rid, p] of this.pending) {
      this.pending.delete(rid);
      p.reject(new Error('connection closed'));
    }
    this.pending.clear();
    // Reject an in-flight OTA chunk too — otherwise sendChunkRaw stalls the full
    // CHUNK_TIMEOUT_MS before the caller learns the stream died.
    if (this.chunkAckRejecter) {
      const r = this.chunkAckRejecter;
      this.chunkAckRejecter = null;
      this.chunkAckResolver = null;
      r(new Error('connection closed during chunk'));
    }
    if (this.wantConnected && this.autoReconnect) {
      const wait = this.reconnectMs;
      this.reconnectMs = Math.min(this.reconnectMs * 2, RECONNECT_MAX_MS);
      setTimeout(() => {
        void this.connect().catch((e) => this.fire('error', e));
      }, wait);
    }
  }

  /* ------------ inbound demux ------------ */

  private onFrame(data: Uint8Array): void {
    let msg: ServerMessage;
    try {
      msg = this.codec.decodeServer(data);
    } catch (e) {
      this.fire('error', e);
      return;
    }
    this.dispatch(msg);
  }

  private dispatch(msg: ServerMessage): void {
    // 1) request/reply match (rid != 0).
    if (msg.requestId !== 0) {
      const p = this.pending.get(msg.requestId);
      if (p) {
        this.pending.delete(msg.requestId);
        this.maybeHandleStaleClient(msg);
        p.resolve(msg);
        return;
      }
    }

    // 2) OtaChunkAck arrives with rid=0 (raw chunk frames carry no request id;
    //    one chunk in flight, sequential offsets serve as implicit ordering).
    if (msg.requestId === 0 &&
        msg.payload.oneofKind === 'otaChunkAck' &&
        this.chunkAckResolver) {
      const r = this.chunkAckResolver;
      this.chunkAckResolver = null;
      this.chunkAckRejecter = null;
      r(Number(msg.payload.otaChunkAck.nextOffset));
      return;
    }

    // 3) push topics.
    this.push.dispatch(msg);
  }

  private maybeHandleStaleClient(msg: ServerMessage): void {
    if (msg.payload.oneofKind !== 'error') return;
    if (msg.payload.error.code !== ErrCode.ERR_STALE_CLIENT) return;
    if (this.stalePromptShown) return;
    this.stalePromptShown = true;
    this.fire('staleClient');
    this.onStaleClient?.();
  }

  /* ------------ outbound ------------ */

  /**
   * Send a ClientMessage payload and await the matching reply. In 'concurrent'
   * mode requests are tracked by rid and may overlap; in 'sequential' mode each
   * send waits for the previous to settle (one-in-flight discipline). `timeoutMs`
   * overrides the default reply window for long applies (whole-unit graph apply).
   */
  send(payload: ClientMessage['payload'], timeoutMs?: number): Promise<ServerMessage> {
    if (this.mode === 'sequential') {
      const run = () => this.sendNow(payload, timeoutMs);
      const next = this.seqChain.then(run, run);
      // Keep the chain alive regardless of this send's outcome.
      this.seqChain = next.then(() => undefined, () => undefined);
      return next;
    }
    return this.sendNow(payload, timeoutMs);
  }

  private sendNow(payload: ClientMessage['payload'], timeoutMs?: number): Promise<ServerMessage> {
    const rid = this.nextRid++;
    const msg: ClientMessage = { requestId: rid, payload };
    const window = timeoutMs ?? this.requestTimeoutMs;
    return new Promise<ServerMessage>((resolve, reject) => {
      const t = setTimeout(() => {
        this.pending.delete(rid);
        reject(new Error('request timed out'));
      }, window);
      this.pending.set(rid, {
        resolve: (m) => { clearTimeout(t); resolve(m); },
        reject: (e) => { clearTimeout(t); reject(e); },
      });
      try {
        const body = this.codec.encodeClient(msg);
        this.transport.send(frameClientMessage(body));
      } catch (e) {
        this.pending.delete(rid);
        clearTimeout(t);
        reject(e as Error);
      }
    });
  }

  /** Expect an Ack or throw with the error detail. The common command path. */
  async sendExpectAck(payload: ClientMessage['payload'], timeoutMs?: number): Promise<Ack> {
    const reply = await this.send(payload, timeoutMs);
    if (reply.payload.oneofKind === 'ack') {
      const ack = reply.payload.ack;
      if (!ack.ok) throw new Error(ack.detail || 'nack');
      return ack;
    }
    if (reply.payload.oneofKind === 'error') {
      const e = reply.payload.error;
      throw new Error(`${e.code}: ${e.detail}`);
    }
    throw new Error(`unexpected reply: ${reply.payload.oneofKind}`);
  }

  /**
   * Send a raw OTA chunk frame; resolves with the server's next expected offset.
   * One chunk in flight at a time — await the returned promise before the next.
   */
  sendChunkRaw(offset: number, data: Uint8Array, timeoutMs = CHUNK_TIMEOUT_MS): Promise<number> {
    if (this.chunkAckResolver) return Promise.reject(new Error('chunk already in flight'));
    if (!this.transport.isOpen()) return Promise.reject(new Error('socket not open'));
    const frame = frameOtaChunk(offset, data);
    return new Promise<number>((resolve, reject) => {
      const t = setTimeout(() => {
        this.chunkAckResolver = null;
        this.chunkAckRejecter = null;
        reject(new Error('chunk ack timeout'));
      }, timeoutMs);
      this.chunkAckResolver = (next) => { clearTimeout(t); resolve(next); };
      this.chunkAckRejecter = (e) => { clearTimeout(t); reject(e); };
      try { this.transport.send(frame); }
      catch (e) {
        this.chunkAckResolver = null;
        this.chunkAckRejecter = null;
        clearTimeout(t);
        reject(e as Error);
      }
    });
  }

  /* ------------ auth (SEC-001) ------------ */

  /**
   * Full SEC-001 challenge-response login. The plaintext password NEVER crosses
   * the wire: request a single-use nonce, derive HMAC-SHA256(password, nonce)
   * locally (pure-JS — crypto.subtle is undefined over http), send only the
   * digest. The firmware recomputes from its NVS password + nonce and
   * constant-time compares.
   */
  async login(password: string, desiredTtlMs = 0): Promise<void> {
    const chReply = await this.send({ oneofKind: 'authChallengeReq', authChallengeReq: {} });
    if (chReply.payload.oneofKind === 'error') {
      throw new Error(chReply.payload.error.detail || 'login failed');
    }
    if (chReply.payload.oneofKind !== 'authChallenge') throw new Error('login failed');
    const nonce = chReply.payload.authChallenge.nonce;

    const hmac = await hmacSha256Password(password, nonce);
    const reply = await this.send({
      oneofKind: 'login',
      login: { password: '', desiredTtlMs, hmac },
    });
    if (reply.payload.oneofKind === 'authOk') {
      this.adoptAuthOk(reply.payload.authOk);
      return;
    }
    if (reply.payload.oneofKind === 'error') {
      throw new Error(reply.payload.error.detail || 'login failed');
    }
    throw new Error('login failed');
  }

  /** Replay a stored token over a reconnect; clears it on ERR_AUTH_EXPIRED. */
  async tryResume(): Promise<boolean> {
    if (!this.token) return false;
    try {
      const reply = await this.send({ oneofKind: 'authResume', authResume: { token: this.token } });
      if (process.env.STRAWBERRY_DEBUG) console.error('[resume] sent token=%o reply=%o', this.token, reply.payload);
      if (reply.payload.oneofKind === 'authOk') {
        this.adoptAuthOk(reply.payload.authOk);
        return true;
      }
      if (reply.payload.oneofKind === 'error' &&
          reply.payload.error.code === ErrCode.ERR_AUTH_EXPIRED) {
        this.clearToken();
        this.authed = false;
        this.fire('authExpired');
      }
      return false;
    } catch {
      // connection died mid-resume; the next open retries.
      return false;
    }
  }

  /** AuthRevoke the active token server-side and clear it locally. */
  async logout(): Promise<void> {
    const t = this.token;
    this.clearToken();
    this._bootOffsetMs = 0;
    this.authed = false;
    if (!t) return;
    try { await this.send({ oneofKind: 'authRevoke', authRevoke: { token: t } }); }
    catch { /* best effort */ }
  }

  private adoptAuthOk(ok: AuthOk): void {
    this.token = ok.token;
    this.tokenStore.set(ok.token);
    // server_now_ms is monotonic since boot; offset to wall clock.
    this._bootOffsetMs = Date.now() - Number(ok.serverNowMs);
    this.authed = true;
    this.fire('authed');
  }

  private clearToken(): void {
    this.token = null;
    this.tokenStore.clear();
  }

  /* ------------ subscriptions ------------ */

  /** Set the full subscription mask. Tracks it locally for incremental edits. */
  subscribe(topics: number): Promise<Ack> {
    this.currentTopics = topics;
    return this.sendExpectAck({ oneofKind: 'subscribe', subscribe: { topics } });
  }
  /** Set additional topic bits without disturbing existing subscriptions. */
  addTopics(mask: number): Promise<Ack> { return this.subscribe(this.currentTopics | mask); }
  /** Clear specific topic bits (e.g. tear down a page-scoped stream). */
  removeTopics(mask: number): Promise<Ack> { return this.subscribe(this.currentTopics & ~mask); }
  /** The subscription mask last sent to the server. */
  topics(): number { return this.currentTopics; }

  /* ------------ queries ------------ */

  /**
   * One-shot typed pull over any of the live WHAT_*.
   *
   * Guards the cast: the firmware does NOT reply with a queryable message for
   * push-only topics. WHAT_SNAPSHOT broadcasts then replies with an Ack, and
   * WHAT_STATS has no query case so it returns ErrorMsg("unknown query") — both
   * subscribe via PushBus (TOPIC_SNAPSHOT/TOPIC_STATS) instead. Without this
   * check the `as Extract<...>` would hand back an Ack/ErrorMsg cast to the
   * caller's expected type, and the typed fields read as undefined downstream.
   */
  async query<T extends ServerMessage['payload']['oneofKind']>(
    what: Query_What,
  ): Promise<Extract<ServerMessage['payload'], { oneofKind: T }>> {
    const reply = await this.send({ oneofKind: 'query', query: { what } });
    if (reply.payload.oneofKind === 'error') {
      const e = reply.payload.error;
      throw new Error(`${e.code}: ${e.detail || 'query failed'}`);
    }
    if (reply.payload.oneofKind === 'ack') {
      // A bare Ack reply means this WHAT is push-only (e.g. SNAPSHOT) — it is not
      // queryable; subscribe to its topic via PushBus instead.
      throw new Error(`query ${what}: push-only WHAT (subscribe to its topic instead)`);
    }
    return reply.payload as Extract<ServerMessage['payload'], { oneofKind: T }>;
  }
}
