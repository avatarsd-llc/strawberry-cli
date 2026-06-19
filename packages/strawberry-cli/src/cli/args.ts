/**
 * A tiny, zero-dependency argv parser for strawberry-cli.
 *
 * Framework-free by mandate (no commander/yargs): the CLI is the third consumer
 * of @avatarsd-llc/strawberry-cli and stays dependency-light so it ships as a
 * self-contained bin. Supports `--flag value`, `--flag=value`, repeated flags
 * (collected into an array), and bare `--bool` switches. Positional arguments
 * (the command path + free args) are returned in order.
 */

export interface ParsedArgs {
  /** Positional args in order (command, subcommand, then any free positionals). */
  positionals: string[];
  /** Flag map: a lone `--x` is `true`; `--x v` is `'v'`; repeats become `string[]`. */
  flags: Map<string, string | boolean | string[]>;
}

/**
 * Flags that take NO value (bare switches). Everything else consumes the next
 * token as its value unless written `--flag=value`. Declaring the booleans up
 * front lets `--json query stats` parse correctly (json is a switch, not a value
 * grabber).
 */
export function parseArgs(argv: string[], booleanFlags: Set<string>): ParsedArgs {
  const positionals: string[] = [];
  const flags = new Map<string, string | boolean | string[]>();

  const put = (name: string, value: string | boolean): void => {
    const existing = flags.get(name);
    if (existing === undefined) { flags.set(name, value); return; }
    // Repeated flag: coalesce into an array (only meaningful for valued flags).
    const arr = Array.isArray(existing) ? existing : [String(existing)];
    arr.push(String(value));
    flags.set(name, arr);
  };

  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === '--') {
      // Everything after `--` is positional.
      for (let j = i + 1; j < argv.length; j++) positionals.push(argv[j]);
      break;
    }
    if (tok.startsWith('--')) {
      const body = tok.slice(2);
      const eq = body.indexOf('=');
      if (eq >= 0) {
        put(body.slice(0, eq), body.slice(eq + 1));
        continue;
      }
      const name = body;
      if (booleanFlags.has(name)) { put(name, true); continue; }
      // Consume the next token as the value unless it looks like another flag.
      const next = argv[i + 1];
      if (next === undefined || (next.startsWith('--') && next.length > 2)) {
        // No value available: treat as a bare boolean switch.
        put(name, true);
      } else {
        put(name, next);
        i++;
      }
      continue;
    }
    positionals.push(tok);
  }

  return { positionals, flags };
}

/** Read a flag as a string, or undefined if absent / a bare boolean. */
export function flagStr(p: ParsedArgs, name: string): string | undefined {
  const v = p.flags.get(name);
  if (v === undefined) return undefined;
  if (Array.isArray(v)) return v[v.length - 1];
  if (typeof v === 'boolean') return undefined;
  return v;
}

/** Read a flag as a list (repeated flags or a single comma-separated value). */
export function flagList(p: ParsedArgs, name: string): string[] {
  const v = p.flags.get(name);
  if (v === undefined) return [];
  if (Array.isArray(v)) return v.flatMap((x) => x.split(','));
  if (typeof v === 'boolean') return [];
  return v.split(',');
}

/** True if a switch is present (either `--x` or `--x=true`). */
export function flagBool(p: ParsedArgs, name: string): boolean {
  const v = p.flags.get(name);
  if (v === undefined) return false;
  if (typeof v === 'boolean') return v;
  const s = String(Array.isArray(v) ? v[v.length - 1] : v).toLowerCase();
  return s !== 'false' && s !== '0' && s !== 'no' && s !== 'off';
}

/** Read a flag as a number, or undefined if absent / unparseable. */
export function flagNum(p: ParsedArgs, name: string): number | undefined {
  const s = flagStr(p, name);
  if (s === undefined) return undefined;
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
}
