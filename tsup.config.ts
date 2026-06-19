import { defineConfig } from 'tsup';

// Three entry points map to the three package subpath exports (ADR-0066 D6):
//   '.'        -> the full client (transport-agnostic core + api builders)
//   './design' -> browser-safe pure models only (zero transport deps; SPA tree-shakes)
//   './node'   -> Node-only surface: FileTokenStore + ws WsTransport + JSONL recorder
//
// noExternal bundles @protobuf-ts/runtime into the CJS output so the Pulumi provider
// host can resolve the package by its bare specifier alone (the closure-serialization
// constraint at infrastructure-strawberry/src/provider.ts:1-16; gated by HIL H10).
export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'design/index': 'src/design/index.ts',
    node: 'src/node.ts',
    // strawberry-cli entry (Node-only): bundled to dist/cli.{mjs,cjs}; the
    // bin/ shim imports the ESM build. Pulls the ./node surface (ws transport +
    // FileTokenStore), so ws stays external like the rest of the Node path.
    cli: 'src/cli/index.ts',
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
