/**
 * strawberry-cli — a framework-free CLI over @avatarsd-llc/strawberry-cli.
 *
 * The third consumer of the shared lib (ADR-0066 R3): every command opens a
 * DeviceClient session (Node ws transport + 0600 FileTokenStore), runs HMAC
 * auth, and drives the proven ws.service.ts logic headless. Supersedes the
 * hand-rolled Python in tools/ (ota_upload.py, wg_provision.py, verify_grow.py,
 * the ws_*_stress.py family, ...).
 *
 * Global flags: --host H, --password / --password-file / $STRAWBERRY_PW, --json.
 * `strawberry help [--json]` prints the full command tree from one spec table so
 * help can never drift from the dispatch.
 */
import { parseArgs, flagBool, type ParsedArgs } from './args.js';
import { printJson, printLine, CliError } from './output.js';
import { QUERY_VERB_LIST } from './commands/query.js';
import { cmdQuery } from './commands/query.js';
import { cmdInfo } from './commands/info.js';
import { cmdAuth } from './commands/auth.js';
import { cmdNet } from './commands/net.js';
import { cmdWg } from './commands/wg.js';
import { cmdOta } from './commands/ota.js';
import { cmdGrow } from './commands/grow.js';
import { cmdControllers } from './commands/controllers.js';
import { cmdSystem } from './commands/system.js';
import { cmdDiag } from './commands/diag.js';
import { cmdProvision } from './commands/provision.js';
import { cmdReboot } from './commands/reboot.js';
import { cmdRaw } from './commands/raw.js';

/** One row per top-level command — the single source for dispatch AND help. */
interface CommandSpec {
  name: string;
  summary: string;
  usage: string;
  run: (p: ParsedArgs) => Promise<void>;
}

const COMMANDS: CommandSpec[] = [
  { name: 'info', summary: 'Connect + print capabilities / flags / wifi', usage: 'info --host H', run: cmdInfo },
  { name: 'connect', summary: 'Alias of info (auth + identity check)', usage: 'connect --host H', run: cmdInfo },
  { name: 'query', summary: `Pull a device state (${QUERY_VERB_LIST.length} verbs)`, usage: `query <${QUERY_VERB_LIST.join('|')}> --host H`, run: cmdQuery },
  { name: 'auth', summary: 'HMAC session: login / resume / revoke', usage: 'auth <login|resume|revoke> --host H', run: cmdAuth },
  { name: 'net', summary: 'Provision Wi-Fi / Home-Assistant; read net info', usage: 'net <wifi|ha|info> --host H', run: cmdNet },
  { name: 'provision', summary: 'Convenience: wifi / wireguard / identity(stub)', usage: 'provision <wifi|wireguard|identity> --host H', run: cmdProvision },
  { name: 'wg', summary: 'WireGuard: apply .conf / disable / status', usage: 'wg <apply|disable|status> --host H', run: cmdWg },
  { name: 'ota', summary: 'Push firmware: app / spa / combined', usage: 'ota upload (--bin|--spa-bin|--combined) F --host H', run: cmdOta },
  { name: 'system', summary: 'Persisted config / boot subsystem flags', usage: 'system <config|flags> --host H', run: cmdSystem },
  { name: 'grow', summary: 'Build a unit: units / endpoints / schedule', usage: 'grow <unit-set|unit-remove|unit-list|io-add|io-remove|io-list|schedule-set> --host H', run: cmdGrow },
  { name: 'controllers', summary: 'Wire the controller graph: apply / list / destroy', usage: 'controllers <graph-apply|list|destroy> --host H', run: cmdControllers },
  { name: 'diag', summary: 'Health: heap / stress / logs', usage: 'diag <heap|stress|logs> --host H [stress: --units N --controllers M --sessions S --aggressive --json]', run: cmdDiag },
  { name: 'reboot', summary: 'Reboot / factory-reset / grow-erase', usage: 'reboot [--factory-reset|--grow-erase] --host H', run: cmdReboot },
  { name: 'raw', summary: 'Send any ClientMessage from JSON (escape hatch)', usage: 'raw --msg FILE.json --host H', run: cmdRaw },
  { name: 'help', summary: 'List every command (--json for machine form)', usage: 'help [--json]', run: cmdHelp },
];

/** Flags that take no value (so the parser doesn't swallow the next token). */
const BOOLEAN_FLAGS = new Set<string>([
  'json', 'active', 'enabled', 'mqtt',
  'factory-reset', 'grow-erase',
  'no-prompt',
  'aggressive',
  'onewire', 'modbus', 'zigbee', 'can',
  'no-onewire', 'no-modbus', 'no-zigbee', 'no-can',
]);

async function cmdHelp(p: ParsedArgs): Promise<void> {
  if (flagBool(p, 'json')) {
    printJson({
      name: 'strawberry',
      globalFlags: {
        '--host': 'board IP, host:port, or ws(s):// URL (required for device commands)',
        '--password': 'plaintext device password (HMAC-only on the wire)',
        '--password-file': 'read the password from a file',
        '--token-file': 'override the 0600 session-token path',
        '--ttl-ms': 'desired session TTL in ms (0 = server default)',
        '--json': 'machine-readable output',
      },
      env: { STRAWBERRY_PW: 'device password fallback', STRAWBERRY_PASSWORD: 'alias of STRAWBERRY_PW' },
      commands: COMMANDS.map((c) => ({ name: c.name, summary: c.summary, usage: c.usage })),
      queryVerbs: QUERY_VERB_LIST,
    });
    return;
  }
  printLine('strawberry — Gorshok-v4 grow controller CLI (WS+protobuf, HMAC auth)');
  printLine('');
  printLine('Usage: strawberry <command> [args] --host <ip> [--password P] [--json]');
  printLine('');
  printLine('Commands:');
  const width = COMMANDS.reduce((w, c) => Math.max(w, c.name.length), 0);
  for (const c of COMMANDS) printLine(`  ${c.name.padEnd(width)}  ${c.summary}`);
  printLine('');
  printLine('Auth: --password, --password-file, or $STRAWBERRY_PW. Plaintext never hits the wire.');
  printLine('Run `strawberry <command>` with no subcommand for that command\'s usage.');
}

export async function main(argv: string[]): Promise<number> {
  const parsed = parseArgs(argv, BOOLEAN_FLAGS);
  const cmdName = parsed.positionals[0];

  if (!cmdName || cmdName === 'help' || flagBool(parsed, 'help')) {
    await cmdHelp(parsed);
    return 0;
  }

  const spec = COMMANDS.find((c) => c.name === cmdName);
  if (!spec) {
    process.stderr.write(`unknown command '${cmdName}'. Run \`strawberry help\`.\n`);
    return 127;
  }

  try {
    await spec.run(parsed);
    return Number(process.exitCode ?? 0);
  } catch (e) {
    if (e instanceof CliError) {
      if (flagBool(parsed, 'json')) printJson({ ok: false, error: e.message });
      else process.stderr.write(`error: ${e.message}\n`);
      return e.code;
    }
    const msg = e instanceof Error ? e.message : String(e);
    if (flagBool(parsed, 'json')) printJson({ ok: false, error: msg });
    else process.stderr.write(`error: ${msg}\n`);
    return 1;
  }
}
