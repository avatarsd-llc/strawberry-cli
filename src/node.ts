/**
 * `@avatarsd-llc/device-client/node` — the Node-only surface (ADR-0066 D6).
 *
 * Kept out of the SPA graph: a FileTokenStore (0600 token persistence) and a
 * ws-based transport for environments without a global WebSocket. The `ws`
 * package is an OPTIONAL peer dependency, dynamically imported inside
 * NodeWsTransport, so it is only required when this subpath is used.
 */
export { FileTokenStore } from './core/token-store-node.js';
export { NodeWsTransport } from './wire/transport-node.js';

// Re-export the full public surface so a Node consumer imports everything from
// one specifier if it wants to.
export * from './index.js';
