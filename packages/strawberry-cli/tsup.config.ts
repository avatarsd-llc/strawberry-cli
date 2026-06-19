import { defineConfig } from 'tsup';

// Single entry: the strawberry-cli (Node-only). Bundled to dist/cli.{mjs,cjs};
// the bin/ shim imports the ESM build (dist/cli.mjs).
//
// Both ws (optional peer) and the strawberry-client library stay external: the CLI
// resolves '@avatarsd-llc/strawberry-client' at runtime from node_modules (the
// installed/published package, symlinked in the workspace during dev), so it is
// NOT inlined into the CLI bundle.
export default defineConfig({
  entry: {
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
  external: ['ws', '@avatarsd-llc/strawberry-client'],
});
