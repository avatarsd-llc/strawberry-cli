/**
 * Shared "open an authenticated session" helper for every command that talks to
 * a board.
 *
 * Builds a Node WsTransport + DeviceClient (sequential request mode — a CLI does
 * one thing at a time and never wants overlapping rids), wires a FileTokenStore
 * so a session survives across runs and the reboots OTA/flags cause, and runs the
 * HMAC login. The plaintext password is resolved from (in order) an explicit
 * flag, a password file, or the STRAWBERRY_PW / STRAWBERRY_PASSWORD env var, and
 * NEVER crosses the wire — DeviceClient.login sends only HMAC-SHA256(pw, nonce).
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFileSync, mkdirSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { DeviceClient, wsUrlForHost, MemoryTokenStore, type TokenStore } from '@avatarsd-llc/strawberry-client';
import { NodeWsTransport, FileTokenStore } from '@avatarsd-llc/strawberry-client/node';
import { CliError } from './output.js';
import { flagStr, flagBool, type ParsedArgs } from './args.js';

/** Where per-host session tokens live (0600 files under ~/.strawberry/tokens). */
export function defaultTokenDir(): string {
  return join(homedir(), '.strawberry', 'tokens');
}

/** A filesystem-safe token filename for a host (one session per host). */
function tokenFileForHost(host: string): string {
  const safe = host.replace(/[^a-zA-Z0-9._-]/g, '_');
  const dir = defaultTokenDir();
  try { mkdirSync(dir, { recursive: true, mode: 0o700 }); } catch { /* best effort */ }
  return join(dir, `${safe}.token`);
}

/** Resolve the token store: an explicit --token-file, else the per-host default. */
export function tokenStoreFor(p: ParsedArgs, host: string): TokenStore {
  const explicit = flagStr(p, 'token-file');
  return new FileTokenStore(explicit ?? tokenFileForHost(host));
}

/** Read the required --host flag or fail with a clear message. */
export function requireHost(p: ParsedArgs): string {
  const host = flagStr(p, 'host');
  if (!host) throw new CliError('missing --host (board IP, host:port, or ws:// URL)');
  return host;
}

/**
 * Resolve the plaintext password without ever logging it. Order:
 *   1. --password VALUE          (explicit, convenient for scripts/CI)
 *   2. --password-file FILE      (file content, trimmed)
 *   3. $STRAWBERRY_PW / $STRAWBERRY_PASSWORD
 *   4. interactive prompt        (only when stdin is a TTY and --no-prompt absent)
 */
export async function resolvePassword(p: ParsedArgs): Promise<string> {
  const direct = flagStr(p, 'password');
  if (direct) return direct;

  const file = flagStr(p, 'password-file');
  if (file) {
    try { return readFileSync(file, 'utf8').replace(/\r?\n$/, ''); }
    catch (e) { throw new CliError(`cannot read --password-file ${file}: ${(e as Error).message}`); }
  }

  const env = process.env.STRAWBERRY_PW ?? process.env.STRAWBERRY_PASSWORD;
  if (env) return env;

  // Interactive prompt only when stdin is a TTY AND --no-prompt was not passed;
  // honoring --no-prompt keeps non-interactive wrappers (that happen to have a
  // TTY) from hanging on the hidden prompt.
  if (process.stdin.isTTY && !flagBool(p, 'no-prompt')) return promptHidden('Device password: ');

  throw new CliError(
    'no password: pass --password, --password-file, or set STRAWBERRY_PW',
  );
}

/** Prompt for a secret on a TTY without echoing it back to the terminal. */
function promptHidden(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const out = process.stdout as unknown as { write: (s: string) => void };
    // Mute echo: intercept the readline output writer while typing.
    const realWrite = process.stdout.write.bind(process.stdout);
    (process.stdout as unknown as { write: (s: string) => boolean }).write = (s: string) => {
      // Let the prompt itself through once; swallow keystroke echoes after.
      if (s.includes(prompt)) return realWrite(s);
      return true;
    };
    out.write(prompt);
    rl.question('', (answer) => {
      (process.stdout as unknown as { write: typeof realWrite }).write = realWrite;
      realWrite('\n');
      rl.close();
      resolve(answer);
    });
  });
}

/** Build a DeviceClient for a host (no connect yet). Sequential mode for the CLI. */
export async function makeClient(host: string, tokenStore: TokenStore): Promise<DeviceClient> {
  const transport = await NodeWsTransport.create(wsUrlForHost(host));
  return new DeviceClient({
    transport,
    tokenStore,
    requestMode: 'sequential',
    autoReconnect: false,
  });
}

export interface Session {
  client: DeviceClient;
  host: string;
}

/**
 * Open a connected, authenticated session: connect (auto-resumes a stored token),
 * and if that did not leave us authed, run a full HMAC login with the resolved
 * password. Caller must `dispose()` (or `client.disconnect()`) when done.
 */
export async function openSession(p: ParsedArgs): Promise<Session> {
  const host = requireHost(p);
  const store = tokenStoreFor(p, host);
  const client = await makeClient(host, store);

  try {
    await client.connect();
  } catch (e) {
    client.disconnect();
    throw new CliError(`cannot reach ${host}: ${(e as Error).message}`);
  }

  if (!client.isAuthed()) {
    const ttl = Number(flagStr(p, 'ttl-ms') ?? 0) || 0;
    const password = await resolvePassword(p);
    try {
      await client.login(password, ttl);
    } catch (e) {
      client.disconnect();
      throw new CliError(`auth failed: ${(e as Error).message}`, 2);
    }
  }

  return { client, host };
}

/**
 * Open a fresh, independently-authed session that does NOT share the per-host
 * token file — each gets a MemoryTokenStore so it consumes its own authed slot
 * on the device. Used by `diag stress --sessions` to drive S concurrent logins
 * against WS_MAX_AUTHED_CLIENTS; never resumes, always runs a full HMAC login.
 * Throws (with the device's error) when the cap rejects the login.
 */
export async function openFreshSession(host: string, password: string, ttlMs = 0): Promise<Session> {
  const client = await makeClient(host, new MemoryTokenStore());
  try {
    await client.connect();
  } catch (e) {
    client.disconnect();
    throw new Error(`cannot reach ${host}: ${(e as Error).message}`);
  }
  try {
    await client.login(password, ttlMs);
  } catch (e) {
    client.disconnect();
    throw e;
  }
  return { client, host };
}

/** Tear down a session's transport. */
export function dispose(s: Session): void {
  try { s.client.disconnect(); } catch { /* already closed */ }
}
