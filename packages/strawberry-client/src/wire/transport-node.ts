/**
 * Node WebSocket transport (the `./node` subpath, ADR-0066 D6).
 *
 * Resolves a WebSocket implementation for Node: the built-in global `WebSocket`
 * (stable since Node 22) is preferred so the CLI runs with zero runtime deps;
 * the `ws` package is an OPTIONAL fallback for older Node, dynamically imported
 * so the SPA build never pulls it in.
 */
import { WsTransport, type WsImpl, type WsTransportOptions } from './transport.js';

/** Resolve a WsImpl: built-in global WebSocket first, then the `ws` package. */
async function loadWsImpl(): Promise<WsImpl> {
  const g = (globalThis as { WebSocket?: unknown }).WebSocket;
  if (typeof g === 'function') return g as WsImpl;
  try {
    const mod = (await import('ws')) as { default?: unknown; WebSocket?: unknown };
    const impl = (mod.default ?? mod.WebSocket ?? mod) as WsImpl;
    return impl;
  } catch {
    throw new Error(
      'NodeWsTransport: no global WebSocket (Node < 22) and the optional `ws` ' +
      'package is not installed. Upgrade to Node 22+ or run `npm i ws`.',
    );
  }
}

export class NodeWsTransport extends WsTransport {
  private constructor(url: string, impl: WsImpl, opts: WsTransportOptions) {
    super(url, { ...opts, WebSocketImpl: impl });
  }

  /**
   * Async factory: dynamically imports `ws` then builds the transport. Async
   * because the `ws` import is lazy (keeps it out of the browser graph).
   */
  static async create(url: string, opts: WsTransportOptions = {}): Promise<NodeWsTransport> {
    const impl = opts.WebSocketImpl ?? (await loadWsImpl());
    return new NodeWsTransport(url, impl, opts);
  }
}
