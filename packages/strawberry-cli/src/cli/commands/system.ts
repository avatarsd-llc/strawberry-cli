/**
 * `strawberry system config|flags` — persisted hardware/runtime config and
 * boot-time subsystem enables.
 *
 *   config : ConfigSet (cfgSet, tag 15) — every field optional; only the flags
 *            you pass are populated, so only those persist.
 *   flags  : SystemFlagsSet (tag 63) — toggle 1-wire/modbus/zigbee/can; persists
 *            NVS, takes effect on next reboot.
 */
import { Query_What, type ConfigSet } from '@avatarsd-llc/strawberry-client/proto';
import { printJson, printLine, printKv, CliError } from '../output.js';
import { flagBool, flagNum, flagStr, type ParsedArgs } from '../args.js';
import { openSession, dispose } from '../connect.js';

export async function cmdSystem(p: ParsedArgs): Promise<void> {
  const sub = p.positionals[1];
  switch (sub) {
    case 'config': return systemConfig(p);
    case 'flags': return systemFlags(p);
    default:
      throw new CliError('system <config|flags>');
  }
}

async function systemConfig(p: ParsedArgs): Promise<void> {
  // Each field is set only if the operator passed it (ConfigSet is all-optional).
  const cfg: ConfigSet = {};
  setStr(cfg, 'password', flagStr(p, 'password'));
  setStr(cfg, 'timezone', flagStr(p, 'timezone'));
  setStr(cfg, 'ntpServer', flagStr(p, 'ntp-server'));
  setStr(cfg, 'theme', flagStr(p, 'theme'));
  setNum(cfg, 'statsPeriodMs', flagNum(p, 'stats-period-ms'));
  setNum(cfg, 'ws2812Count', flagNum(p, 'ws2812-count'));
  setNum(cfg, 'hx711Scale', flagNum(p, 'hx711-scale'));
  setNum(cfg, 'hx711Offset', flagNum(p, 'hx711-offset'));
  setNum(cfg, 'gpio2Mode', flagNum(p, 'gpio2-mode'));
  setNum(cfg, 'flow1Ppl', flagNum(p, 'flow1-ppl'));
  setNum(cfg, 'flow2Ppl', flagNum(p, 'flow2-ppl'));
  setNum(cfg, 'displayLayout', flagNum(p, 'display-layout'));
  setNum(cfg, 'displayRotation', flagNum(p, 'display-rotation'));

  if (Object.keys(cfg).length === 0) {
    throw new CliError('system config: pass at least one field (e.g. --ws2812-count 12)');
  }

  const session = await openSession(p);
  try {
    await session.client.sendExpectAck({ oneofKind: 'cfgSet', cfgSet: cfg });
    if (flagBool(p, 'json')) {
      printJson({ ok: true, set: { ...cfg, password: cfg.password ? '<redacted>' : undefined } });
    } else {
      printLine(`config set: ${Object.keys(cfg).filter((k) => k !== 'password').join(', ') || '(password)'}`);
    }
  } finally {
    dispose(session);
  }
}

async function systemFlags(p: ParsedArgs): Promise<void> {
  // Read current flags first so unspecified toggles are preserved.
  const session = await openSession(p);
  try {
    const reply = await session.client.query<'systemFlags'>(Query_What.SYSTEM_FLAGS);
    const cur = reply.oneofKind === 'systemFlags' ? reply.systemFlags : null;
    if (!cur) throw new CliError('cannot read current SystemFlags');

    const onewire = triState(p, 'onewire', cur.onewireEnabled);
    const modbus = triState(p, 'modbus', cur.modbusEnabled);
    const zigbee = triState(p, 'zigbee', cur.zigbeeEnabled);
    const can = triState(p, 'can', cur.canEnabled);

    const changed = onewire !== cur.onewireEnabled || modbus !== cur.modbusEnabled
      || zigbee !== cur.zigbeeEnabled || can !== cur.canEnabled;

    if (!changed) {
      if (flagBool(p, 'json')) printJson({ ok: true, changed: false, flags: cur });
      else { printLine('system flags (unchanged)'); printKv(Object.entries(cur)); }
      return;
    }

    await session.client.sendExpectAck({
      oneofKind: 'systemFlagsSet',
      systemFlagsSet: { onewireEnabled: onewire, modbusEnabled: modbus, zigbeeEnabled: zigbee, canEnabled: can },
    });
    const next = { onewireEnabled: onewire, modbusEnabled: modbus, zigbeeEnabled: zigbee, canEnabled: can };
    if (flagBool(p, 'json')) printJson({ ok: true, changed: true, flags: next, note: 'pending reboot' });
    else { printLine('system flags set (pending reboot)'); printKv(Object.entries(next)); }
  } finally {
    dispose(session);
  }
}

/** A `--x on|off` / `--x` (=> on) / `--no-x` tri-state over the current value. */
function triState(p: ParsedArgs, name: string, current: boolean): boolean {
  if (p.flags.has(`no-${name}`)) return false;
  const v = p.flags.get(name);
  if (v === undefined) return current;
  if (v === true) return true;
  const s = String(v).toLowerCase();
  return s === 'on' || s === 'true' || s === '1' || s === 'yes';
}

function setStr(cfg: ConfigSet, key: keyof ConfigSet, v: string | undefined): void {
  if (v !== undefined) (cfg as Record<string, unknown>)[key] = v;
}
function setNum(cfg: ConfigSet, key: keyof ConfigSet, v: number | undefined): void {
  if (v !== undefined) (cfg as Record<string, unknown>)[key] = v;
}
