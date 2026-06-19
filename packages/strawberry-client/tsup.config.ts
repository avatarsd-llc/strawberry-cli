import { defineConfig } from 'tsup';

// Entry points map to the package subpath exports (ADR-0066 D6):
//   '.'         -> the full client (transport-agnostic core + api builders)
//   './design'  -> browser-safe pure models only (zero transport deps; SPA tree-shakes)
//   './node'    -> Node-only surface: FileTokenStore + ws WsTransport + JSONL recorder
//   './proto'   -> the raw protobuf-ts message vocabulary (ClientMessage/ServerMessage/...),
//                  imported directly by strawberry-cli command modules.
//
// noExternal bundles @protobuf-ts/runtime into the CJS output so the Pulumi provider
// host can resolve the package by its bare specifier alone (the closure-serialization
// constraint at infrastructure-strawberry/src/provider.ts:1-16; gated by HIL H10).
export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'design/index': 'src/design/index.ts',
    node: 'src/node.ts',
    'proto/index': 'src/proto/index.ts',
  },
  format: ['esm', 'cjs'],
  outExtension({ format }) {
    return { js: format === 'esm' ? '.mjs' : '.cjs' };
  },
  dts: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
  // ws stays external (optional peer dependency); the protobuf runtime is bundled so
  // the CJS artifact is self-contained for the Pulumi provider host.
  external: ['ws'],
  noExternal: ['@protobuf-ts/runtime'],
});
