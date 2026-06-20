/**
 * `strawberry info` / `strawberry connect` — open an authenticated session and
 * print the board's identity: capabilities, system flags, Wi-Fi state. The fast
 * "is this board reachable and who is it" check.
 */
import { Query_What } from '@avatarsd-llc/strawberry-client/proto';
import { printJson, printKv, printLine } from '../output.js';
import { flagBool, type ParsedArgs } from '../args.js';
import { openSession, dispose } from '../connect.js';

export async function cmdInfo(p: ParsedArgs): Promise<void> {
  const session = await openSession(p);
  try {
    const caps = await session.client.query<'capabilities'>(Query_What.CAPABILITIES);
    const flags = await session.client.query<'systemFlags'>(Query_What.SYSTEM_FLAGS);
    const wifi = await session.client.query<'wifi'>(Query_What.WIFI);

    const capabilities = caps.oneofKind === 'capabilities' ? caps.capabilities : null;
    const systemFlags = flags.oneofKind === 'systemFlags' ? flags.systemFlags : null;
    const wifiState = wifi.oneofKind === 'wifi' ? wifi.wifi : null;

    if (flagBool(p, 'json')) {
      printJson({
        host: session.host,
        authed: session.client.isAuthed(),
        bootOffsetMs: session.client.bootOffsetMs(),
        capabilities,
        systemFlags,
        wifi: wifiState,
      });
    } else {
      printLine(`host        ${session.host}  (authed)`);
      if (capabilities) {
        printLine('capabilities');
        printKv(Object.entries(capabilities).map(([k, v]) => [`  ${k}`, v]));
      }
      if (systemFlags) {
        printLine('system_flags');
        // A capability-gated subsystem the board lacks is "absent", not "disabled":
        // the enable flag is meaningless when zigbee isn't compiled in (4MB image).
        const zbAbsent = !!capabilities && !capabilities.zigbee;
        printKv(Object.entries(systemFlags).map(([k, v]) =>
          [`  ${k}`, k === 'zigbeeEnabled' && zbAbsent ? 'absent (not built)' : v]));
      }
      if (wifiState) {
        printLine('wifi');
        printKv(Object.entries(wifiState).map(([k, v]) => [`  ${k}`, v]));
      }
    }
  } finally {
    dispose(session);
  }
}
