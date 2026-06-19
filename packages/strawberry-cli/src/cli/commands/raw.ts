/**
 * `strawberry raw --msg FILE.json` — the escape hatch.
 *
 * Sends an arbitrary ClientMessage payload (any of the 64 oneof variants) and
 * prints the decoded ServerMessage. The JSON file is the `payload` oneof shape
 * protobuf-ts expects, e.g.:
 *   { "oneofKind": "query", "query": { "what": 2 } }
 *   { "oneofKind": "growUnitRemove", "growUnitRemove": { "id": "grow.1" } }
 *
 * For any variant the typed commands don't wrap yet. Bytes fields must be passed
 * base64-encoded and won't auto-decode here — use the typed commands for those.
 */
import { readFileSync } from 'node:fs';
import type { ClientMessage } from '@avatarsd-llc/strawberry-client/proto';
import { printJson, printLine, CliError } from '../output.js';
import { flagBool, flagNum, flagStr, type ParsedArgs } from '../args.js';
import { openSession, dispose } from '../connect.js';

export async function cmdRaw(p: ParsedArgs): Promise<void> {
  const file = flagStr(p, 'msg');
  if (!file) throw new CliError('raw requires --msg FILE.json (a ClientMessage payload oneof)');
  let payload: ClientMessage['payload'];
  try {
    const doc = JSON.parse(readFileSync(file, 'utf8'));
    if (!doc || typeof doc !== 'object' || typeof doc.oneofKind !== 'string') {
      throw new Error('expected { "oneofKind": "...", "<oneofKind>": {...} }');
    }
    payload = doc as ClientMessage['payload'];
  } catch (e) {
    throw new CliError(`bad --msg JSON: ${(e as Error).message}`);
  }

  const timeoutMs = flagNum(p, 'timeout-ms');
  const session = await openSession(p);
  try {
    const reply = await session.client.send(payload, timeoutMs);
    if (flagBool(p, 'json')) {
      printJson({ requestId: reply.requestId, kind: reply.payload.oneofKind, payload: reply.payload });
    } else {
      printLine(`<- ${reply.payload.oneofKind}`);
      const body = (reply.payload as Record<string, unknown>)[reply.payload.oneofKind as string];
      printJson(body);
    }
  } finally {
    dispose(session);
  }
}
