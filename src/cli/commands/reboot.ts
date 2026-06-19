/**
 * `strawberry reboot [--factory-reset|--grow-erase]` — lifecycle.
 *
 *   (default)         Reboot (tag 25) — clean restart.
 *   --grow-erase      GrowEraseSettings (tag 72) — wipe units/schedules/graph;
 *                     wifi creds + system settings survive; device reboots.
 *   --factory-reset   FactoryReset (tag 48) — full wipe incl. wifi creds.
 *
 * The reboot drops the socket before the ack lands; that is treated as success.
 */
import { printJson, printLine, CliError } from '../output.js';
import { flagBool, type ParsedArgs } from '../args.js';
import { openSession, dispose } from '../connect.js';

export async function cmdReboot(p: ParsedArgs): Promise<void> {
  const factory = flagBool(p, 'factory-reset');
  const growErase = flagBool(p, 'grow-erase');
  if (factory && growErase) throw new CliError('reboot: pick one of --factory-reset / --grow-erase');

  // FactoryReset is guarded by a confirm magic word (ws_h_system.c).
  const FACTORY_RESET_MAGIC = 0xfac70819;
  const payload = factory
    ? { oneofKind: 'factoryReset' as const, factoryReset: { confirm: FACTORY_RESET_MAGIC } }
    : growErase
      ? { oneofKind: 'growEraseSettings' as const, growEraseSettings: {} }
      : { oneofKind: 'reboot' as const, reboot: { delayMs: 0 } };
  const action = factory ? 'factory-reset' : growErase ? 'grow-erase' : 'reboot';

  const session = await openSession(p);
  try {
    try {
      await session.client.sendExpectAck(payload, 5000);
    } catch {
      // The device reboots before acking; the dropped socket is the expected path.
    }
    if (flagBool(p, 'json')) printJson({ ok: true, action, note: 'device rebooting' });
    else printLine(`${action}: device rebooting`);
  } finally {
    dispose(session);
  }
}
