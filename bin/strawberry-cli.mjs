#!/usr/bin/env node
/**
 * strawberry-cli bin shim.
 *
 * Thin launcher: import the bundled ESM CLI (dist/cli.mjs), run main() with the
 * process argv (dropping `node` + this script), and map the returned code to the
 * process exit code so shells and agents can branch on success/failure.
 */
import { main } from '../dist/cli.mjs';

main(process.argv.slice(2))
  .then((code) => { process.exitCode = code; })
  .catch((err) => {
    process.stderr.write(`fatal: ${err?.stack || err}\n`);
    process.exitCode = 1;
  });
