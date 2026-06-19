/**
 * Transport seam (ADR-0066 D1/D11) — absorbed from the dormant SDK.
 *
 * DeviceClient talks to the device through this minimal byte-pipe interface and
 * never names a WebSocket. That is THE libtracer seam: a TLV/serial/other
 * transport implements `Transport` and drops in unchanged.
 *
 * `WsTransport` is the WebSocket implementation. It defaults to the global
 * `WebSocket` (browsers, and Node >=22 which ships a global) but accepts an
 * `opts.WebSocketImpl` override so the `ws` package can be injected on Node
 * (see ./transport-node.ts, the `./node` subpath). `WsLike` is a structural
 * type covering exactly the surface used here, so neither the DOM lib nor
 * `@types/ws` is required.
 */

/** The minimal byte-pipe DeviceClient depends on. */
export interface Transport {
  /** Open the connection. Resolves once the socket is OPEN. */
  connect(): Promise<void>;
  /** Send one binary frame. */
  send(data: Uint8Array): void;
  /** Register the inbound-frame handler. */
  onMessage(cb: (data: Uint8Array) => void): void;
  /** Register the close handler (fired on remote close, error, or local close). */
  onClose(cb: () => void): void;
  /** True while the socket is OPEN. */
  isOpen(): boolean;
  /** Tear down the connection. */
  close(): void;
}

/** Structural subset of the WebSocket API actually used by WsTransport. */
export interface WsLike {
  binaryType: string;
  readyState: number;
  send(data: ArrayBufferView | ArrayBufferLike): void;
  close(): void;
  onopen: ((ev: unknown) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
}

/** Constructor shape for a WebSocket implementation (global `WebSocket`, `ws`, ...). */
export type WsImpl = new (url: string) => WsLike;

export interface WsTransportOptions {
  /**
   * WebSocket implementation to use. Defaults to the global `WebSocket`. The
   * Node entry (./node) passes the `ws` package here.
   */
  WebSocketImpl?: WsImpl;
  /** OPEN-wait cap for connect(). Default 10000 ms. */
  openTimeoutMs?: number;
}

const WS_OPEN = 1;

export class WsTransport implements Transport {
  private ws: WsLike | null = null;
  private readonly url: string;
  private readonly WebSocketImpl: WsImpl;
  private readonly openTimeoutMs: number;
  private messageCb: ((data: Uint8Array) => void) | null = null;
  private closeCb: (() => void) | null = null;

  constructor(url: string, opts: WsTransportOptions = {}) {
    const impl = opts.WebSocketImpl ?? (globalThis as { WebSocket?: WsImpl }).WebSocket;
    if (!impl) {
      throw new Error(
        'WsTransport: no WebSocket implementation. Pass opts.WebSocketImpl ' +
        '(e.g. the `ws` package) or use NodeWsTransport from the ./node subpath.',
      );
    }
    this.url = url;
    this.WebSocketImpl = impl;
    this.openTimeoutMs = opts.openTimeoutMs ?? 10000;
  }

  connect(): Promise<void> {
    if (this.ws && this.ws.readyState === WS_OPEN) return Promise.resolve();
    const ws = new this.WebSocketImpl(this.url);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;

    ws.onmessage = (ev: { data: unknown }) => {
      if (!this.messageCb) return;
      this.messageCb(toUint8(ev.data));
    };
    ws.onerror = () => { /* surfaced as a close; lib reconnects */ };

    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('socket open timeout'));
      }, this.openTimeoutMs);
      ws.onopen = () => { clearTimeout(timer); resolve(); };
      // Single onclose binding: pre-open it rejects connect(); post-open the reject
      // is a no-op (promise already settled) and only closeCb fires — the lib's
      // reconnect path. (A separate pre-resolve assignment would just be overwritten.)
      ws.onclose = () => { clearTimeout(timer); this.closeCb?.(); reject(new Error('socket closed')); };
    });
  }

  send(data: Uint8Array): void {
    if (!this.ws || this.ws.readyState !== WS_OPEN) throw new Error('socket not open');
    this.ws.send(data);
  }

  onMessage(cb: (data: Uint8Array) => void): void { this.messageCb = cb; }
  onClose(cb: () => void): void { this.closeCb = cb; }
  isOpen(): boolean { return !!this.ws && this.ws.readyState === WS_OPEN; }

  close(): void {
    const ws = this.ws;
    this.ws = null;
    try { ws?.close(); } catch { /* already closing */ }
  }
}

/** Normalize whatever the socket hands us (ArrayBuffer / Buffer / Uint8Array) to Uint8Array. */
function toUint8(data: unknown): Uint8Array {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  // A text frame (or an injected WsImpl that doesn't honor binaryType='arraybuffer')
  // delivers a string; encode it rather than throwing the opaque error below.
  if (typeof data === 'string') return new TextEncoder().encode(data);
  // Node `ws` may hand a Buffer (a Uint8Array subclass already caught above) or
  // an array of Buffers when fragmented; flatten defensively.
  if (Array.isArray(data)) {
    const total = data.reduce((n: number, b: ArrayBufferView) => n + b.byteLength, 0);
    const out = new Uint8Array(total);
    let off = 0;
    for (const b of data as ArrayBufferView[]) {
      out.set(new Uint8Array(b.buffer, b.byteOffset, b.byteLength), off);
      off += b.byteLength;
    }
    return out;
  }
  if (data && typeof data === 'object' && 'buffer' in (data as ArrayBufferView)) {
    const v = data as ArrayBufferView;
    return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  }
  const ctor = (data && typeof data === 'object') ? (data as object).constructor?.name : typeof data;
  throw new Error(`unsupported WS message payload type: ${ctor ?? typeof data}`);
}

/**
 * Build a `ws://`/`wss://` URL for a host that may be a bare host, host:port, or
 * an already-complete ws(s):// or http(s):// URL. The `/ws` path is appended
 * when the input is just a host.
 */
export function wsUrlForHost(host: string): string {
  if (/^wss?:\/\//i.test(host)) return host;
  if (/^https?:\/\//i.test(host)) {
    const u = host.replace(/^http/i, 'ws');
    return u.endsWith('/ws') ? u : `${u.replace(/\/$/, '')}/ws`;
  }
  return `ws://${host.replace(/\/$/, '')}/ws`;
}
