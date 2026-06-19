#!/usr/bin/env node
/**
 * run-sil.mjs — SIL (software-in-the-loop) acceptance run for strawberry-cli.
 *
 * Boots the protocol-faithful mock-board WS server (sil/mock-board.mjs) on a
 * loopback port, then drives the REAL strawberry-cli binary against it and
 * asserts one row per command. This is the host-runnable twin of
 * scripts/hil-matrix.mjs: the HIL matrix needs a live board, this needs nothing
 * but Node + the built dist, so it runs in CI.
 *
 * The mock reproduces the documented firmware QUIRKS, so the SIL expectations
 * MATCH the HIL ones row-for-row:
 *   - query stats        -> "unknown query" (push-only on the fw; B2)
 *   - auth resume         -> rejected (tokens are socket-bound; B1)
 *   - grow io-add to an inactive (active=false) unit -> ERR_NOT_FOUND/404
 *     (apply_unit only registers active units; the OPEN finding)
 *   - grow io-add to an active unit -> ok
 *
 * Exit 0 iff every row meets its expectation; non-zero otherwise.
 *
 *   node sil/run-sil.mjs                 # ephemeral port, HOME sandboxed
 *   MOCK_BOARD_PORT=8090 node sil/run-sil.mjs
 */
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

const run = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = join(HERE, '..');
const BIN = join(PKG, 'bin', 'strawberry-cli.mjs');
const MOCK = join(HERE, 'mock-board.mjs');
const PASSWORD = 'strawberry';
const PORT = Number(process.env.MOCK_BOARD_PORT ?? 0) || pickPort();
const HOST = `127.0.0.1:${PORT}`;
const UID = 'silmx';

function pickPort() { return 8000 + Math.floor(Math.random() * 1000); }

/* A sandboxed HOME so the per-host FileTokenStore (~/.strawberry/tokens) never
   leaks between runs and a stale token can't perturb the auth rows. */
const SANDBOX_HOME = mkdtempSync(join(tmpdir(), 'sil-home-'));

async function cli(argv, timeout = 15000) {
  const env = { ...process.env, HOME: SANDBOX_HOME, MOCK_BOARD_PASSWORD: PASSWORD };
  try {
    const { stdout, stderr } = await run('node', [BIN, ...argv], { timeout, env });
    return { ok: true, out: `${stdout}${stderr}`, code: 0 };
  } catch (e) {
    return { ok: false, out: `${e.stdout || ''}${e.stderr || ''}` || e.message, code: e.code ?? 1 };
  }
}

const auth = (extra) => [...extra, '--host', HOST, '--password', PASSWORD, '--json'];

/* Read-only queries the firmware actually answers (WHAT_STATS is excluded — it
   is push-only and asserted as a LIMIT row below). */
const QUERIES = ['capabilities', 'wifi', 'snapshot', 'device_config', 'grow_config',
  'system_flags', 'time', 'ow_config', 'ha', 'ow_sensors', 'soil', 'ota',
  'device_list', 'wireguard', 'wg_status'];

const rows = [
  { tier: 'READ', name: 'help --json', run: () => cli(['help', '--json']), expect: (r) => r.ok && /"commands"/.test(r.out) },
  { tier: 'READ', name: 'info', run: () => cli(auth(['info'])), expect: (r) => r.ok && /"authed": true/.test(r.out) },
  ...QUERIES.map((w) => ({
    tier: 'READ', name: `query ${w}`, run: () => cli(auth(['query', w])),
    expect: (r) => r.ok && !/unknown command/.test(r.out),
  })),
  { tier: 'READ', name: 'grow unit-list', run: () => cli(auth(['grow', 'unit-list'])), expect: (r) => r.ok },
  { tier: 'READ', name: 'controllers list', run: () => cli(auth(['controllers', 'list'])), expect: (r) => r.ok },

  // LIMIT — documented firmware limitations; assert the EXPECTED rejection.
  {
    tier: 'LIMIT', name: 'query stats (push-only -> unknown query)',
    run: () => cli(auth(['query', 'stats'])),
    expect: (r) => /unknown query/.test(r.out) && !/unknown command/.test(r.out),
    note: 'B2: WHAT_STATS has no query case; stats rides TOPIC_STATS',
  },
  {
    tier: 'LIMIT', name: 'auth login',
    run: () => cli(auth(['auth', 'login'])),
    expect: (r) => r.ok && /"action": "logged in"/.test(r.out),
  },
  {
    tier: 'LIMIT', name: 'auth resume (socket-bound token -> rejected)',
    run: () => cli(auth(['auth', 'resume'])),
    expect: (r) => !r.ok && /expired|invalid|rejected|no stored token/.test(r.out),
    note: 'B1: tokens are socket-bound; cross-process resume cannot work',
  },

  // MUTATE — exercises the create/add/list/remove lifecycle AND the active=false quirk.
  {
    tier: 'LIMIT', name: 'grow io-add to inactive unit (-> ERR_NOT_FOUND)',
    run: async () => {
      await cli(auth(['grow', 'unit-set', '--id', UID, '--name', 'SILMX'])); // no --active
      return cli(auth(['grow', 'io-add', '--unit', UID, '--name', 'probe', '--role', 'input', '--dtype', 'f32']));
    },
    expect: (r) => !r.ok && /404|not found/.test(r.out),
    note: 'OPEN finding: apply_unit only registers active units; io-add 404s',
  },
  {
    tier: 'MUTATE', name: 'grow unit-set --active + io-add + io-list + cleanup',
    run: async () => {
      const id = `${UID}a`;
      const set = await cli(auth(['grow', 'unit-set', '--id', id, '--name', 'SILA', '--active']));
      const add = await cli(auth(['grow', 'io-add', '--unit', id, '--name', 'probe', '--role', 'input', '--dtype', 'f32']));
      const list = await cli(auth(['grow', 'io-list', '--unit', id]));
      const rm = await cli(auth(['grow', 'io-remove', '--unit', id, '--name', 'probe']));
      const del = await cli(auth(['grow', 'unit-remove', '--id', id]));
      const ok = set.ok && add.ok && /probe/.test(list.out) && rm.ok && del.ok;
      return { ok, out: `set=${set.ok} add=${add.ok} list=${/probe/.test(list.out)} rm=${rm.ok} del=${del.ok}` };
    },
    expect: (r) => r.ok,
  },

  // DRY — destructive commands: prove they PARSE + fail cleanly against a dead host (never execute).
  { tier: 'DRY', name: 'ota upload (parse only)', run: () => cli(['ota', 'upload', '--bin', '/dev/null', '--host', '10.255.255.255', '--password', 'x', '--json'], 10000), expect: (r) => !/unknown command/.test(r.out) },
  { tier: 'DRY', name: 'reboot (parse only)', run: () => cli(['reboot', '--host', '10.255.255.255', '--password', 'x', '--json'], 10000), expect: (r) => !/unknown command/.test(r.out) },
  { tier: 'DRY', name: 'net wifi (parse only)', run: () => cli(['net', 'wifi', '--ssid', 'X', '--wifi-pass', 'Y', '--host', '10.255.255.255', '--password', 'x', '--json'], 10000), expect: (r) => !/unknown command/.test(r.out) },
  { tier: 'DRY', name: 'wg status (parse only)', run: () => cli(['wg', 'status', '--host', '10.255.255.255', '--password', 'x', '--json'], 10000), expect: (r) => !/unknown command/.test(r.out) },
  { tier: 'DRY', name: 'raw escape hatch (parse only)', run: () => cli(['raw', '--json-msg', '{"oneofKind":"query","query":{"what":15}}', '--host', '10.255.255.255', '--password', 'x', '--json'], 10000), expect: (r) => !/unknown command/.test(r.out) },
];

/* ---- mock lifecycle ------------------------------------------------------- */
function startMock() {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [MOCK], {
      env: { ...process.env, MOCK_BOARD_PORT: String(PORT), MOCK_BOARD_PASSWORD: PASSWORD, MOCK_BOARD_QUIET: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let ready = false;
    const onData = (b) => {
      if (!ready && /MOCK_BOARD_READY/.test(b.toString())) { ready = true; resolve(child); }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', () => {});
    child.on('exit', (c) => { if (!ready) reject(new Error(`mock exited before ready (code ${c})`)); });
    setTimeout(() => { if (!ready) { child.kill('SIGKILL'); reject(new Error('mock failed to become ready in 5s')); } }, 5000);
  });
}

/* --external => the mock is already listening on $HOST (e.g. a docker container
   started by `npm run sil:docker`); don't spawn our own. */
const EXTERNAL = process.argv.includes('--external') || process.env.MOCK_BOARD_EXTERNAL === '1';

const main = async () => {
  let mock = null;
  if (!EXTERNAL) {
    try { mock = await startMock(); }
    catch (e) { console.error(`[sil] ${e.message}`); process.exit(3); }
  }

  console.log(`[sil] mock-board ${EXTERNAL ? 'external' : 'up'} on ws://${HOST}/ws — running ${rows.length} rows\n`);
  let pass = 0, fail = 0;
  const fails = [];
  for (const row of rows) {
    let r;
    try { r = await row.run(); } catch (e) { r = { ok: false, out: e.message }; }
    const ok = !!row.expect(r);
    if (ok) pass++; else { fail++; fails.push(row.name); }
    const tail = (r.out || '').replace(/\s+/g, ' ').slice(0, 72);
    console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${row.tier.padEnd(6)} ${row.name}${row.note ? `  (${row.note})` : ''}`);
    if (!ok) console.log(`         got: ${tail}`);
  }

  if (mock) { try { mock.kill('SIGTERM'); } catch { /* gone */ } }
  console.log(`\n=== SIL matrix: ${pass} pass / ${fail} fail / ${rows.length} rows ===`);
  if (fail) console.log(`failing rows: ${fails.join(', ')}`);
  process.exit(fail === 0 ? 0 : 2);
};
main();
