/**
 * `strawberry query <what>` — one-shot pull of any of the 16 live Query.What
 * states. The verb vocabulary is generated from the lib's live Query_What enum,
 * so it is provably the device's vocabulary (no drift).
 */
import { Query_What } from '../../proto/messages.js';
import { CliError, printJson, printKv } from '../output.js';
import { flagBool, type ParsedArgs } from '../args.js';
import { openSession, dispose } from '../connect.js';

/**
 * verb -> Query_What. Sorted by how an operator thinks, not enum order.
 *
 * SNAPSHOT and STATS are intentionally absent: they are push-only on the
 * firmware (SNAPSHOT replies with a bare Ack after broadcasting; STATS has no
 * query case and returns "unknown query"). Read them by subscribing to
 * TOPIC_SNAPSHOT / TOPIC_STATS via PushBus, not through `query`.
 */
export const QUERY_VERBS: Record<string, Query_What> = {
  ow_sensors: Query_What.OW_SENSORS,
  soil: Query_What.SOIL,
  wifi: Query_What.WIFI,
  ha: Query_What.HA,
  ota: Query_What.OTA,
  device_list: Query_What.DEVICE_LIST,
  device_config: Query_What.DEVICE_CONFIG,
  time: Query_What.TIME,
  grow_config: Query_What.GROW_CONFIG,
  system_flags: Query_What.SYSTEM_FLAGS,
  wireguard: Query_What.WIREGUARD,
  wg_status: Query_What.WG_STATUS,
  capabilities: Query_What.CAPABILITIES,
  ow_config: Query_What.OW_CONFIG,
};

export const QUERY_VERB_LIST = Object.keys(QUERY_VERBS);

export async function cmdQuery(p: ParsedArgs): Promise<void> {
  const verb = p.positionals[1];
  if (!verb) {
    throw new CliError(`query <what> — one of: ${QUERY_VERB_LIST.join(', ')}`);
  }
  const what = QUERY_VERBS[verb];
  if (what === undefined) {
    throw new CliError(`unknown query '${verb}'. valid: ${QUERY_VERB_LIST.join(', ')}`);
  }

  const session = await openSession(p);
  try {
    let reply;
    try {
      reply = await session.client.query(what);
    } catch (e) {
      // query() now throws on an error/ack reply (push-only WHAT or device error)
      // rather than handing back a mistyped payload; surface it as a clean CliError.
      throw new CliError(`query ${verb} failed: ${(e as Error).message}`);
    }
    // The payload union is { oneofKind, [oneofKind]: <value> }; surface the value.
    const body = (reply as Record<string, unknown>)[reply.oneofKind as string];
    if (flagBool(p, 'json')) {
      printJson({ what: verb, kind: reply.oneofKind, value: body });
    } else if (body && typeof body === 'object') {
      printKv(Object.entries(body as Record<string, unknown>));
    } else {
      printJson(body);
    }
  } finally {
    dispose(session);
  }
}
