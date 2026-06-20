/**
 * `strawberry diag heap|stress|logs` — on-device health diagnosis.
 *
 *   heap   : poll WHAT_STATS for --seconds; report free-heap trend + min_free
 *            watermark + largest-block.
 *   stress : COMPREHENSIVE capacity / graceful-degradation stress. Drives five
 *            axes against a board and asserts it DEGRADES CLEANLY (clean denials,
 *            never a crash/wedge): mass unit fan-out (--units), mass controller
 *            fan-out in one unit (--controllers), concurrent authed sessions vs
 *            the 3-client cap (--sessions), rapid create/delete/bind churn
 *            (--aggressive), and orphan-endpoint verification after a unit is
 *            deleted. Throughout it watches min_free / largest-block, detects a
 *            reboot (min_free rises) and a wedge (timeout / lost connection), and
 *            emits a structured PASS/FAIL verdict (non-zero exit on FAIL).
 *   logs   : subscribe TOPIC_LOG and stream LogBatch entries for --seconds.
 *
 * Supersedes the WS plumbing of tools/ws_heap_probe.py / ws_system_stress.py /
 * log_triage.py; the deeper analytics ride on top as harnesses.
 */
import { Topic, GrowKind, LogLevel, IoStruct_Op, type Stats } from '@avatarsd-llc/strawberry-client/proto';
import {
  growUnitSet, growUnitRemove, growUserIoAdd, ctrlGraphApply,
  type ControllerCreate,
} from '@avatarsd-llc/strawberry-client';
import { printJson, printLine, CliError } from '../output.js';
import { flagBool, flagNum, type ParsedArgs } from '../args.js';
import { openSession, openFreshSession, resolvePassword, requireHost, dispose, type Session } from '../connect.js';
import {
  STRESS_UNIT_PREFIX, classifyDenial, classifyFanoutAxis, classifyClientCapAxis,
  orphanIds, detectReboot, aggregateVerdict,
  type AxisResult, type Denial, type StressVerdict,
} from './stress-verdict.js';

export async function cmdDiag(p: ParsedArgs): Promise<void> {
  const sub = p.positionals[1];
  switch (sub) {
    case 'heap': return diagHeap(p);
    case 'stress': return diagStress(p);
    case 'logs': return diagLogs(p);
    default:
      throw new CliError('diag <heap|stress|logs>');
  }
}

type HeapSample = { free: number; min: number; largest: number; uptimeMs: number };

/* The firmware does NOT answer Query{WHAT_STATS} — Stats is push-only on
   TOPIC_STATS (verified on hardware). Await the next pushed Stats frame; the
   caller must have subscribed to Topic.STATS first. */
function nextStats(session: Session, timeoutMs = 6000): Promise<HeapSample> {
  return new Promise((resolve, reject) => {
    const cb = (s: Stats): void => {
      clearTimeout(timer);
      session.client.push.off('stats', cb);
      resolve({ free: s.freeHeap, min: s.minFreeHeap, largest: s.largestFreeBlock, uptimeMs: Number(s.uptimeMs) });
    };
    const timer = setTimeout(() => {
      session.client.push.off('stats', cb);
      reject(new CliError(`no Stats frame within ${timeoutMs}ms (is TOPIC_STATS subscribed?)`));
    }, timeoutMs);
    session.client.push.on('stats', cb);
  });
}

async function diagHeap(p: ParsedArgs): Promise<void> {
  const seconds = flagNum(p, 'seconds') ?? 10;
  const session = await openSession(p);
  try {
    await session.client.subscribe(Topic.STATS);
    const samples: number[] = [];
    let minFree = Infinity;
    let firstLargest = 0;
    const deadline = Date.now() + seconds * 1000;
    let first = true;
    do {
      const s = await nextStats(session);   // paced by the ~1 Hz push
      samples.push(s.free);
      minFree = Math.min(minFree, s.min);
      if (first) { firstLargest = s.largest; first = false; }
      if (!flagBool(p, 'json')) {
        printLine(`free=${s.free}  min_free=${s.min}  largest=${s.largest}  up=${(s.uptimeMs / 1000).toFixed(0)}s`);
      }
    } while (Date.now() < deadline);

    const trend = samples.length > 1 ? samples[samples.length - 1] - samples[0] : 0;
    if (flagBool(p, 'json')) {
      printJson({ samples: samples.length, minFreeHeap: minFree, freeTrend: trend, firstLargestBlock: firstLargest });
    } else {
      printLine(`--- min_free=${minFree}  free trend=${trend >= 0 ? '+' : ''}${trend} over ${samples.length} samples`);
    }
  } finally {
    dispose(session);
  }
}

/* ======================== comprehensive stress ========================= */

/** A heap watermark the stress threads through every axis. */
interface HeapWatch {
  /** Lowest min_free observed so far (the floor we measure reboots against). */
  minFloor: number;
  /** Lowest largest-free-block observed. */
  largestLow: number;
  reboots: number;
  wedges: number;
}

/** Sample Stats once, fold it into the watermark, and flag a reboot if min rose. */
async function observe(session: Session, w: HeapWatch): Promise<HeapSample | null> {
  try {
    const s = await nextStats(session);
    if (detectReboot(w.minFloor, s.min)) w.reboots++;
    w.minFloor = Math.min(w.minFloor, s.min);
    w.largestLow = Math.min(w.largestLow, s.largest);
    return s;
  } catch {
    // No Stats frame in time during a busy axis is a soft miss, not a wedge by
    // itself — the explicit op timeouts below are what flag a wedge.
    return null;
  }
}

/** Turn a thrown error into a classified denial (its message carries the code). */
function denialFrom(e: unknown): Denial {
  return classifyDenial(e instanceof Error ? e.message : String(e));
}

const STRESS_KIND = 'affine';                 // always-creates; zeroed 20B params ok
const STRESS_CTRL_PARAMS = new Uint8Array(0); // empty -> firmware fills defaults

/**
 * Axis 1 — mass unit creation. Create `target` GrowKind.CUSTOM (cheapest) units
 * named with the stress prefix until they all land OR the device denies cleanly
 * (admission deny / busy / no-mem at the ceiling). Records every id it created
 * so cleanup removes ONLY those.
 */
async function axisUnits(
  session: Session, target: number, w: HeapWatch, created: Set<string>, json: boolean,
): Promise<AxisResult> {
  let achieved = 0;
  let limit: Denial | undefined;
  for (let i = 0; i < target; i++) {
    const id = `${STRESS_UNIT_PREFIX}.u${i}`;
    try {
      await growUnitSet(session.client, { id, name: 'STRESS', kind: GrowKind.CUSTOM, active: true });
      created.add(id);
      achieved++;
    } catch (e) {
      limit = denialFrom(e);
      if (limit.reason === 'timeout' || limit.reason === 'closed') w.wedges++;
      break;
    }
    if (i % 4 === 0) await observe(session, w);
  }
  await observe(session, w);
  if (!json) printLine(`[units] created ${achieved}/${target}${limit ? `  denied: ${limit.reason} (${limit.detail})` : ''}`);
  return classifyFanoutAxis('units', target, achieved, limit);
}

/**
 * Axis 2 — mass controller fan-out inside ONE unit. Apply `target` affine nodes
 * via the atomic graph-apply primitive, in batches (one frame per batch so a
 * single oversized frame never exceeds the RX cap). Stops at the first batch the
 * device denies; the achieved count is the last fully-applied batch boundary.
 */
async function axisControllers(
  session: Session, target: number, w: HeapWatch, created: Set<string>, json: boolean,
): Promise<AxisResult> {
  const unitId = `${STRESS_UNIT_PREFIX}.ctrlhost`;
  // A dedicated host unit (its own teardown sweeps the controllers with it).
  await growUnitSet(session.client, { id: unitId, name: 'STRESS', kind: GrowKind.CUSTOM, active: true });
  created.add(unitId);

  const BATCH = 16;
  let achieved = 0;
  let limit: Denial | undefined;
  for (let base = 0; base < target && !limit; base += BATCH) {
    const n = Math.min(BATCH, target - base);
    const nodes: ControllerCreate[] = [];
    for (let k = 0; k < n; k++) {
      nodes.push({
        kind: STRESS_KIND,
        instanceId: `${unitId}.c${base + k}`,
        params: STRESS_CTRL_PARAMS,
        inputs: [],
        outputs: [],
      } as ControllerCreate);
    }
    try {
      // A loaded graph-apply can run past the generic window.
      await ctrlGraphApply(session.client, nodes, 30000);
      achieved += n;
    } catch (e) {
      limit = denialFrom(e);
      if (limit.reason === 'timeout' || limit.reason === 'closed') w.wedges++;
    }
    await observe(session, w);
  }
  if (!json) printLine(`[controllers] created ${achieved}/${target} in ${unitId}${limit ? `  denied: ${limit.reason} (${limit.detail})` : ''}`);
  return classifyFanoutAxis('controllers', target, achieved, limit, { unitId });
}

/**
 * Axis 3 — concurrent authed sessions vs WS_MAX_AUTHED_CLIENTS (3). Open `target`
 * fresh logins in parallel (each its own MemoryTokenStore so it consumes a
 * distinct authed slot). Assert EXACTLY 3 authenticate and the rest are rejected
 * with a clean busy denial ("server at capacity: max 3 clients"). Closes every
 * session it opened.
 */
async function axisSessions(
  host: string, password: string, target: number, occupied: number, json: boolean,
): Promise<AxisResult> {
  const results = await Promise.allSettled(
    Array.from({ length: target }, () => openFreshSession(host, password)),
  );
  const opened: Session[] = [];
  const rejected: Denial[] = [];
  for (const r of results) {
    if (r.status === 'fulfilled') opened.push(r.value);
    else rejected.push(denialFrom(r.reason));
  }
  const authed = opened.length;
  for (const s of opened) dispose(s);
  if (!json) printLine(`[sessions] authed ${authed}  rejected ${rejected.length} (${rejected.map((d) => d.reason).join(',') || '-'})  (${occupied} slot held by control session)`);
  return classifyClientCapAxis(target, authed, rejected, 3, occupied);
}

/**
 * Axis 4 — aggressive create/delete/bind churn (no think-time). Each cycle:
 * create a unit + two affine controllers wired in a chain (a cross-controller
 * binding), then delete the unit (sweeping its controllers + the binding). This
 * stresses fragmentation and the teardown path. The axis passes if every cycle
 * either completed or the device denied cleanly; a wedge fails it.
 */
async function axisAggressive(
  session: Session, cycles: number, w: HeapWatch, created: Set<string>, json: boolean,
): Promise<AxisResult> {
  let done = 0;
  let limit: Denial | undefined;
  for (let i = 0; i < cycles && !limit; i++) {
    const unitId = `${STRESS_UNIT_PREFIX}.agg${i}`;
    try {
      await growUnitSet(session.client, { id: unitId, name: 'STRESS', kind: GrowKind.CUSTOM, active: true });
      created.add(unitId);
      // A user input endpoint to bind the chain head against; the chain wires
      // src -> sink (slot 0) so a real cross-controller binding is exercised.
      await growUserIoAdd(session.client, unitId, { name: 'in', role: 0, dtype: 3, unit: '', flags: 0 });
      const src = `${unitId}.src`;
      const sink = `${unitId}.sink`;
      const nodes: ControllerCreate[] = [
        { kind: STRESS_KIND, instanceId: src, params: STRESS_CTRL_PARAMS,
          inputs: [{ slot: 0, ioId: `${unitId}.in` }], outputs: [] } as ControllerCreate,
        { kind: STRESS_KIND, instanceId: sink, params: STRESS_CTRL_PARAMS,
          inputs: [{ slot: 0, ioId: src }], outputs: [] } as ControllerCreate,
      ];
      await ctrlGraphApply(session.client, nodes, 30000);
      await growUnitRemove(session.client, unitId);
      created.delete(unitId);
      done++;
    } catch (e) {
      limit = denialFrom(e);
      if (limit.reason === 'timeout' || limit.reason === 'closed') w.wedges++;
      // Leave the unit in `created` so cleanup removes whatever survived.
    }
    if (i % 4 === 0) await observe(session, w);
  }
  await observe(session, w);
  if (!json) printLine(`[aggressive] completed ${done}/${cycles} churn cycles${limit ? `  stopped: ${limit.reason} (${limit.detail})` : ''}`);
  // Aggressive is a churn axis, not a fan-out ceiling: completing fewer than the
  // requested cycles is only a failure if the stop was non-graceful.
  return classifyFanoutAxis('aggressive', cycles, done, limit);
}

/**
 * Collect the device's currently-registered endpoint ids by subscribing
 * TOPIC_IO_STRUCT — on subscribe the firmware replays one IoStruct{REGISTERED}
 * per live entry. We gather for `settleMs` (the replay is a burst) and return the
 * set of ids that are still registered.
 */
async function registeredEndpointIds(session: Session, settleMs = 1500): Promise<Set<string>> {
  const ids = new Set<string>();
  const onStruct = (s: { op: number; entry?: { id: string } }): void => {
    if (!s.entry) return;
    if (s.op === IoStruct_Op.REGISTERED) ids.add(s.entry.id);
    else if (s.op === IoStruct_Op.UNREGISTERED) ids.delete(s.entry.id);
  };
  session.client.push.on('ioStruct', onStruct);
  try {
    await session.client.subscribe(Topic.IO_STRUCT);
    await sleep(settleMs);
  } finally {
    session.client.push.off('ioStruct', onStruct);
  }
  return ids;
}

/**
 * Remove only the units this run created (and any aggressive survivors). Best
 * effort: a unit that is already gone (or the device denied during stress) is
 * tolerated. Never touches a unit it did not create.
 */
async function cleanupUnits(session: Session, created: Set<string>): Promise<void> {
  for (const id of created) {
    try { await growUnitRemove(session.client, id); } catch { /* already gone */ }
  }
}

async function diagStress(p: ParsedArgs): Promise<void> {
  const json = flagBool(p, 'json');
  const units = flagNum(p, 'units') ?? 32;
  const controllers = flagNum(p, 'controllers') ?? 320;
  const sessions = flagNum(p, 'sessions') ?? 5;
  const aggressive = flagBool(p, 'aggressive');
  const aggressiveCycles = flagNum(p, 'aggressive-cycles') ?? 12;

  const host = requireHost(p);
  // Resolve the password ONCE up front so the parallel session axis can re-login
  // without re-prompting; the plaintext never leaves this process.
  const password = await resolvePassword(p);

  const session = await openSession(p);
  const created = new Set<string>();
  const w: HeapWatch = { minFloor: Infinity, largestLow: Infinity, reboots: 0, wedges: 0 };
  const axes: AxisResult[] = [];
  let orphans: string[] = [];

  try {
    await session.client.subscribe(Topic.STATS);
    const baseline = await nextStats(session);
    w.minFloor = baseline.min;
    w.largestLow = baseline.largest;
    if (!json) printLine(`[baseline] free=${baseline.free}  min_free=${baseline.min}  largest=${baseline.largest}`);

    // Axis 1 — unit fan-out.
    if (units > 0) axes.push(await axisUnits(session, units, w, created, json));

    // Axis 2 — controller fan-out in one unit.
    if (controllers > 0) axes.push(await axisControllers(session, controllers, w, created, json));

    // Axis 4 — aggressive churn (opt-in; interleaves create/delete/bind).
    if (aggressive) axes.push(await axisAggressive(session, aggressiveCycles, w, created, json));

    // Axis 3 — concurrent session cap. Run after the heap is loaded so the cap,
    // not a fluke, is what rejects. The control session above holds one slot, so
    // the new logins race for the remaining authed slots up to the cap.
    if (sessions > 0) axes.push(await axisSessions(host, password, sessions, 1, json));

    // Axis 5 — orphan verification (always). Tear down the unit/controller hosts
    // we created, then confirm NO endpoint id under their prefix survives.
    await cleanupUnits(session, created);
    const cleaned = new Set(created);
    created.clear();
    const live = await registeredEndpointIds(session);
    const liveIds = [...live];
    for (const unitId of cleaned) {
      orphans.push(...orphanIds(liveIds, unitId));
    }
    if (!json) printLine(`[orphans] ${orphans.length} survivor(s) after teardown${orphans.length ? ': ' + orphans.slice(0, 5).join(', ') : ''}`);

    await observe(session, w);
  } catch (e) {
    // An unexpected throw on the control session is a wedge/crash signal.
    w.wedges++;
    if (!json) printLine(`[fatal] control session error: ${(e as Error).message}`);
  } finally {
    // Final safety sweep — remove anything still tagged as ours.
    try { await cleanupUnits(session, created); } catch { /* best effort */ }
    dispose(session);
  }

  const verdict: StressVerdict = aggregateVerdict({
    axes,
    minFreeHeap: Number.isFinite(w.minFloor) ? w.minFloor : 0,
    largestFreeBlockLow: Number.isFinite(w.largestLow) ? w.largestLow : 0,
    orphans,
    reboots: w.reboots,
    wedges: w.wedges,
  });

  emitVerdict(verdict, json);
  if (!verdict.pass) process.exitCode = 1;
}

function emitVerdict(v: StressVerdict, json: boolean): void {
  if (json) { printJson(v); return; }
  printLine('--- stress verdict ---');
  for (const a of v.axes) {
    const tag = a.pass ? 'PASS' : 'FAIL';
    const lim = a.limit ? `  limit=${a.limit.reason}` : '';
    const notes = a.notes ? `  ${JSON.stringify(a.notes)}` : '';
    printLine(`  ${tag}  ${a.axis}: ${a.achieved}/${a.target}${lim}${notes}`);
  }
  printLine(`  min_free=${v.minFreeHeap}  largest_low=${v.largestFreeBlockLow}  orphans=${v.orphans.length}  reboots=${v.reboots}  wedges=${v.wedges}`);
  for (const f of v.failures) printLine(`  ! ${f}`);
  printLine(`=== ${v.pass ? 'PASS' : 'FAIL'} ===`);
}

async function diagLogs(p: ParsedArgs): Promise<void> {
  const seconds = flagNum(p, 'seconds') ?? 10;
  const json = flagBool(p, 'json');
  const session = await openSession(p);
  try {
    session.client.push.on('log', (e) => {
      const line = { level: LogLevel[e.level], tag: e.tag, message: e.message, ts: e.timestampMs };
      if (json) printJson(line);
      else printLine(`${LogLevel[e.level] ?? e.level}\t${e.tag}\t${e.message}`);
    });
    await session.client.subscribe(Topic.LOG);
    await sleep(seconds * 1000);
    if (!json) printLine(`--- streamed logs for ${seconds}s`);
  } finally {
    dispose(session);
  }
}

function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }
