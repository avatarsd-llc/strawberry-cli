/**
 * `strawberry diag heap|stress|logs` — on-device health diagnosis.
 *
 *   heap   : poll WHAT_STATS for --seconds; report free-heap trend + min_free
 *            watermark + largest-block.
 *   stress : light unit-churn (create/destroy a STRESS unit --iterations times)
 *            while watching min_free — a capacity smoke test, NOT the full
 *            7-phase firmware stress (that stays a harness on top of the lib).
 *   logs   : subscribe TOPIC_LOG and stream LogBatch entries for --seconds.
 *
 * Supersedes the WS plumbing of tools/ws_heap_probe.py / ws_system_stress.py /
 * log_triage.py; the deeper analytics ride on top as harnesses.
 */
import { Topic, GrowKind, LogLevel, type Stats } from '../../proto/messages.js';
import { growUnitSet, growUnitRemove } from '../../api/commands.js';
import { printJson, printLine, CliError } from '../output.js';
import { flagBool, flagNum, type ParsedArgs } from '../args.js';
import { openSession, dispose, type Session } from '../connect.js';

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

async function diagStress(p: ParsedArgs): Promise<void> {
  const iterations = flagNum(p, 'iterations') ?? 10;
  const id = 'grow.diagstress';
  const session = await openSession(p);
  try {
    await session.client.subscribe(Topic.STATS);
    const before = await nextStats(session);
    let minFree = before.min;
    for (let i = 0; i < iterations; i++) {
      await growUnitSet(session.client, { id, name: 'STRESS', kind: GrowKind.SUBSTRATE, active: false });
      const s = await nextStats(session);
      minFree = Math.min(minFree, s.min);
      await growUnitRemove(session.client, id);
      if (!flagBool(p, 'json')) printLine(`iter ${i + 1}/${iterations}  free=${s.free}  min_free=${s.min}`);
    }
    // Best-effort cleanup in case the loop bailed mid-way.
    try { await growUnitRemove(session.client, id); } catch { /* already gone */ }
    const after = await nextStats(session);
    const leaked = before.free - after.free;
    if (flagBool(p, 'json')) {
      printJson({ iterations, minFreeHeap: minFree, freeBefore: before.free, freeAfter: after.free, deltaFree: leaked });
    } else {
      printLine(`--- ${iterations} cycles  min_free=${minFree}  free ${before.free}->${after.free} (delta ${leaked})`);
    }
  } finally {
    dispose(session);
  }
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
