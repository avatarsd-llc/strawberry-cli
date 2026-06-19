/**
 * `strawberry grow ...` — build a cultivation unit.
 *
 *   unit-set     create/update a unit (the container for endpoints + graph + schedule)
 *   unit-remove  remove a unit by id
 *   unit-list    list units from GrowConfig
 *   io-add       add a user-defined IO endpoint (full id = <unit>.<name>)
 *   io-remove    remove a user-defined endpoint
 *   io-list      list a unit's endpoints
 *   schedule-set push a unit's working schedule from a JSON file
 *
 * Supersedes tools/verify_grow.py (unit set/remove + grow query).
 */
import { readFileSync } from 'node:fs';
import { GrowKind } from '@avatarsd-llc/strawberry-client/proto';
import {
  growUnitSet, growUnitRemove, growUserIoAdd, growUserIoRemove, growScheduleSet, getGrowConfig,
} from '@avatarsd-llc/strawberry-client';
import { printJson, printLine, CliError } from '../output.js';
import { flagBool, flagNum, flagStr, type ParsedArgs } from '../args.js';
import { openSession, dispose } from '../connect.js';

/** io_role_t (firmware): 0=input, 1=output, 2=virtual. */
const IO_ROLE: Record<string, number> = { input: 0, output: 1, virtual: 2 };
/** io_dtype_t (firmware): 0=bool, 1=i32, 2=u32, 3=f32. */
const IO_DTYPE: Record<string, number> = { bool: 0, i32: 1, u32: 2, f32: 3 };
/** IO_FLAG_MQTT_EXPOSED bit (D12). */
const IO_FLAG_MQTT_EXPOSED = 1 << 0;

const GROW_KINDS: Record<string, GrowKind> = {
  substrate: GrowKind.SUBSTRATE,
  hydro_pure: GrowKind.HYDRO_PURE,
  hydro_substrate: GrowKind.HYDRO_SUBSTRATE,
  aero: GrowKind.AERO,
  aquaponic: GrowKind.AQUAPONIC,
  aquarium: GrowKind.AQUARIUM,
};

export async function cmdGrow(p: ParsedArgs): Promise<void> {
  const sub = p.positionals[1];
  switch (sub) {
    case 'unit-set': case 'unit-create': return unitSet(p);
    case 'unit-remove': return unitRemove(p);
    case 'unit-list': case 'list': return unitList(p);
    case 'io-add': return ioAdd(p);
    case 'io-remove': return ioRemove(p);
    case 'io-list': return ioList(p);
    case 'schedule-set': return scheduleSet(p);
    default:
      throw new CliError('grow <unit-set|unit-remove|unit-list|io-add|io-remove|io-list|schedule-set>');
  }
}

async function unitSet(p: ParsedArgs): Promise<void> {
  const id = flagStr(p, 'id');
  if (!id) throw new CliError('grow unit-set requires --id (e.g. grow.1)');
  const kindStr = flagStr(p, 'kind');
  if (kindStr && GROW_KINDS[kindStr] === undefined) {
    throw new CliError(`unknown --kind '${kindStr}'. valid: ${Object.keys(GROW_KINDS).join(', ')}`);
  }
  const session = await openSession(p);
  try {
    await growUnitSet(session.client, {
      id,
      name: flagStr(p, 'name') ?? id,
      kind: kindStr ? GROW_KINDS[kindStr] : GrowKind.SUBSTRATE,
      // Default ACTIVE: the firmware only materializes (registers io endpoints +
      // controllers for) active units, so an inactive unit can't take a grow
      // io-add (ERR_NOT_FOUND). Configuring a unit implies activating it, as the
      // SPA does. --inactive opts out.
      active: !flagBool(p, 'inactive'),
    });
    ok(p, `unit set: ${id}`);
  } finally {
    dispose(session);
  }
}

async function unitRemove(p: ParsedArgs): Promise<void> {
  const id = flagStr(p, 'id');
  if (!id) throw new CliError('grow unit-remove requires --id');
  const session = await openSession(p);
  try {
    await growUnitRemove(session.client, id);
    ok(p, `unit removed: ${id}`);
  } finally {
    dispose(session);
  }
}

async function unitList(p: ParsedArgs): Promise<void> {
  const session = await openSession(p);
  try {
    const cfg = await getGrowConfig(session.client);
    if (flagBool(p, 'json')) {
      printJson(cfg.units.map((u) => ({ id: u.id, name: u.name, kind: GrowKind[u.kind], active: u.active })));
    } else {
      for (const u of cfg.units) printLine(`${u.id}\t${u.active ? 'active' : 'inactive'}\t${u.name}`);
      if (cfg.units.length === 0) printLine('(no units)');
    }
  } finally {
    dispose(session);
  }
}

async function ioAdd(p: ParsedArgs): Promise<void> {
  const unitId = flagStr(p, 'unit');
  const name = flagStr(p, 'name');
  if (!unitId || !name) throw new CliError('grow io-add requires --unit and --name');
  const roleStr = flagStr(p, 'role') ?? 'input';
  const dtypeStr = flagStr(p, 'dtype') ?? 'f32';
  if (IO_ROLE[roleStr] === undefined) throw new CliError(`--role one of: ${Object.keys(IO_ROLE).join(', ')}`);
  if (IO_DTYPE[dtypeStr] === undefined) throw new CliError(`--dtype one of: ${Object.keys(IO_DTYPE).join(', ')}`);

  const session = await openSession(p);
  try {
    await growUserIoAdd(session.client, unitId, {
      name,
      role: IO_ROLE[roleStr],
      dtype: IO_DTYPE[dtypeStr],
      unit: flagStr(p, 'unit-hint') ?? '',
      flags: flagBool(p, 'mqtt') ? IO_FLAG_MQTT_EXPOSED : 0,
    });
    ok(p, `io added: ${unitId}.${name} (${roleStr}/${dtypeStr})`);
  } finally {
    dispose(session);
  }
}

async function ioRemove(p: ParsedArgs): Promise<void> {
  const unitId = flagStr(p, 'unit');
  const name = flagStr(p, 'name');
  if (!unitId || !name) throw new CliError('grow io-remove requires --unit and --name');
  const session = await openSession(p);
  try {
    await growUserIoRemove(session.client, unitId, name);
    ok(p, `io removed: ${unitId}.${name}`);
  } finally {
    dispose(session);
  }
}

async function ioList(p: ParsedArgs): Promise<void> {
  const unitId = flagStr(p, 'unit');
  if (!unitId) throw new CliError('grow io-list requires --unit');
  const session = await openSession(p);
  try {
    const reply = await session.client.send({ oneofKind: 'growUserIoListReq', growUserIoListReq: { unitId } });
    if (reply.payload.oneofKind !== 'growUserIoList') {
      const detail = reply.payload.oneofKind === 'error' ? reply.payload.error.detail : reply.payload.oneofKind;
      throw new CliError(`io-list failed: ${detail}`);
    }
    const list = reply.payload.growUserIoList;
    if (flagBool(p, 'json')) printJson(list);
    else {
      for (const d of list.entries) printLine(`${unitId}.${d.name}\trole=${d.role}\tdtype=${d.dtype}\tunit=${d.unit}`);
      if (list.entries.length === 0) printLine('(no endpoints)');
    }
  } finally {
    dispose(session);
  }
}

async function scheduleSet(p: ParsedArgs): Promise<void> {
  const unitId = flagStr(p, 'unit');
  const file = flagStr(p, 'schedule');
  if (!unitId || !file) throw new CliError('grow schedule-set requires --unit and --schedule FILE.json');
  let doc: { params?: unknown[]; stages?: unknown[]; derivedMask?: number; derived_mask?: number };
  try { doc = JSON.parse(readFileSync(file, 'utf8')); }
  catch (e) { throw new CliError(`cannot read schedule JSON: ${(e as Error).message}`); }

  const session = await openSession(p);
  try {
    await growScheduleSet(session.client, {
      id: unitId,
      params: (doc.params ?? []) as never[],
      stages: (doc.stages ?? []) as never[],
      derivedMask: (doc.derivedMask ?? doc.derived_mask ?? flagNum(p, 'derived-mask')) as number | undefined,
    });
    ok(p, `schedule set: ${unitId} (${(doc.params ?? []).length} params, ${(doc.stages ?? []).length} stages)`);
  } finally {
    dispose(session);
  }
}

function ok(p: ParsedArgs, line: string): void {
  if (flagBool(p, 'json')) printJson({ ok: true, message: line });
  else printLine(line);
}
