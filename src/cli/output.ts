/**
 * Output + error helpers shared by every CLI command.
 *
 * `--json` flips every command into machine-readable mode: one JSON document on
 * stdout, nothing else. Without it, commands print a short human line. Errors
 * always exit non-zero; in `--json` mode they print `{ "ok": false, "error": ... }`
 * so an agent driving the CLI can branch on the exit code AND parse the reason.
 */

/** A command failure that carries a clean message and a process exit code. */
export class CliError extends Error {
  readonly code: number;
  constructor(message: string, code = 1) {
    super(message);
    this.name = 'CliError';
    this.code = code;
  }
}

/**
 * Protobuf-ts encodes 64-bit fields as strings and bytes as Uint8Array; neither
 * round-trips cleanly through JSON.stringify. This replacer renders Uint8Array as
 * a hex string and leaves bigint-as-string fields untouched (they are already
 * strings on the wire types).
 */
function jsonReplacer(_key: string, value: unknown): unknown {
  if (value instanceof Uint8Array) {
    return Buffer.from(value).toString('hex');
  }
  if (typeof value === 'bigint') return value.toString();
  return value;
}

export function printJson(value: unknown): void {
  process.stdout.write(JSON.stringify(value, jsonReplacer, 2) + '\n');
}

export function printLine(line: string): void {
  process.stdout.write(line + '\n');
}

/** Print a key/value block in aligned columns (human mode). */
export function printKv(rows: Array<[string, unknown]>): void {
  const width = rows.reduce((w, [k]) => Math.max(w, k.length), 0);
  for (const [k, v] of rows) {
    printLine(`${k.padEnd(width)}  ${formatVal(v)}`);
  }
}

function formatVal(v: unknown): string {
  if (v instanceof Uint8Array) return Buffer.from(v).toString('hex');
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') return JSON.stringify(v, jsonReplacer);
  return String(v);
}
