#!/usr/bin/env node
/* Generate the protobuf-ts codec (src/proto/messages.ts) from the firmware's
 * messages.proto via @protobuf-ts/plugin. Run via `npm run proto`. The output is
 * gitignored (ADR-0066 D2) and regenerated before build/test.
 *
 * Options match web-ui/scripts/gen-proto.mjs verbatim so the SPA and this library
 * share a byte-identical codec.
 *
 * Proto path: ../../components/proto (in-tree under strawberry-fw). When this
 * package is split into its own avatarsd-llc/strawberry-cli repo, point PROTO_DIR
 * (env override) at the vendored/submodule proto.
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { mkdirSync, existsSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const proto = process.env.PROTO_DIR
  ? resolve(process.env.PROTO_DIR)
  : resolve(root, 'proto');
const outDir = resolve(root, 'src/proto');

if (!existsSync(resolve(proto, 'messages.proto'))) {
  console.error(`gen-proto: messages.proto not found at ${proto}. Set PROTO_DIR to the proto dir.`);
  process.exit(1);
}
mkdirSync(outDir, { recursive: true });

// In an npm workspace the @protobuf-ts/plugin binaries hoist to the monorepo
// root node_modules/.bin, not the package-local one. Walk up from the package
// dir until we find the .bin entry (package-local first, then the workspace root).
function findBin(name) {
  let dir = root;
  for (let i = 0; i < 6; i++) {
    const candidate = resolve(dir, 'node_modules/.bin', name);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return resolve(root, 'node_modules/.bin', name);
}

const protoc = findBin('protoc');
const plugin = findBin('protoc-gen-ts');
const args = [
  `--plugin=protoc-gen-ts=${plugin}`,
  `--ts_out=${outDir}`,
  '--ts_opt=long_type_string,client_none,server_none',
  `-I=${proto}`,
  `${proto}/messages.proto`,
];
console.log('protoc', args.join(' '));
const r = spawnSync(protoc, args, { stdio: 'inherit' });
process.exit(r.status ?? 1);
