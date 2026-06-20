/**
 * `strawberry auth login|resume|revoke` — HMAC session lifecycle.
 *
 *   login  : HMAC challenge-response, persist the token to the FileTokenStore.
 *   resume : replay a stored token across a reconnect / firmware reboot.
 *   revoke : invalidate the token server-side and clear it locally.
 *
 * The plaintext password NEVER crosses the wire — DeviceClient.login sends only
 * HMAC-SHA256(password, server-nonce), pure-JS (crypto.subtle is undefined over
 * plain http).
 */
import { printJson, printLine, CliError } from '../output.js';
import { flagBool, flagNum, type ParsedArgs } from '../args.js';
import {
  requireHost, tokenStoreFor, makeClient, resolvePassword, dispose,
} from '../connect.js';

export async function cmdAuth(p: ParsedArgs): Promise<void> {
  const sub = p.positionals[1];
  switch (sub) {
    case 'login': return authLogin(p);
    case 'resume': return authResume(p);
    case 'revoke': return authRevoke(p);
    default:
      throw new CliError('auth <login|resume|revoke>');
  }
}

async function authLogin(p: ParsedArgs): Promise<void> {
  const host = requireHost(p);
  const store = tokenStoreFor(p, host);
  const client = await makeClient(host, store);
  try {
    await client.connect();
    const password = await resolvePassword(p);
    const ttl = flagNum(p, 'ttl-ms') ?? 0;
    await client.login(password, ttl);
    report(p, host, true, 'logged in', client.bootOffsetMs());
  } catch (e) {
    throw new CliError(`login failed: ${(e as Error).message}`, 2);
  } finally {
    dispose({ client, host });
  }
}

async function authResume(p: ParsedArgs): Promise<void> {
  const host = requireHost(p);
  const store = tokenStoreFor(p, host);
  if (!store.get()) throw new CliError('no stored token to resume (run `auth login` first)');
  const client = await makeClient(host, store);
  try {
    await client.connect();
    const ok = client.isAuthed() || (await client.tryResume());
    if (!ok) throw new CliError('resume rejected (token expired or invalid)', 2);
    report(p, host, true, 'resumed', client.bootOffsetMs());
  } finally {
    dispose({ client, host });
  }
}

async function authRevoke(p: ParsedArgs): Promise<void> {
  const host = requireHost(p);
  const store = tokenStoreFor(p, host);
  const client = await makeClient(host, store);
  try {
    await client.connect();
    await client.logout();
    report(p, host, false, 'revoked', 0);
  } finally {
    dispose({ client, host });
  }
}

function report(p: ParsedArgs, host: string, authed: boolean, action: string, bootOffsetMs: number): void {
  if (flagBool(p, 'json')) {
    printJson({ ok: true, host, action, authed, bootOffsetMs });
  } else {
    printLine(`${action}: ${host}`);
  }
}
