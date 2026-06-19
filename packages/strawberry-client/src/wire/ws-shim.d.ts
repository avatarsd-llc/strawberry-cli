/**
 * Ambient shim for the OPTIONAL `ws` peer dependency.
 *
 * `ws` is dynamically imported only inside NodeWsTransport (the `./node`
 * subpath); the SPA never pulls it. Declaring it ambiently lets the library
 * typecheck and bundle even when `ws` is not installed (it stays external in
 * tsup). The structural `WsLike` type in transport.ts covers the actual API
 * surface, so no `@types/ws` is required.
 */
declare module 'ws' {
  const anyExport: unknown;
  export default anyExport;
  export const WebSocket: unknown;
}
