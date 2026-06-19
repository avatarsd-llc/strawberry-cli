#!/usr/bin/env node
// Purity gate (ADR-0066 D5): the shared library MUST stay framework-free so it runs
// unchanged in the browser, Node, the Pulumi provider host, and the agent-skill.
// Fail the build if any source file imports @angular/* or rxjs. Run in CI.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'src');
const FORBIDDEN = [/from\s+['"]@angular\//, /from\s+['"]rxjs['"]/, /from\s+['"]rxjs\//];

/** @param {string} dir @returns {string[]} */
function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

let violations = 0;
for (const file of walk(SRC)) {
  const text = readFileSync(file, 'utf8');
  for (const re of FORBIDDEN) {
    if (re.test(text)) {
      console.error(`purity: forbidden import ${re} in ${file}`);
      violations++;
    }
  }
}

if (violations > 0) {
  console.error(`purity gate FAILED: ${violations} framework import(s) in the lib`);
  process.exit(1);
}
console.log('purity gate OK: no @angular/* or rxjs imports in the lib');
