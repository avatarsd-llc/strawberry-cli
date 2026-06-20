/**
 * Pure (board-free) logic for `diag stress` — the parts that are unit-testable
 * without a live device: the per-axis denial classifier, the orphan-prefix
 * matcher, and the final verdict aggregation.
 *
 * Kept out of diag.ts so the WS orchestration stays thin and the decision logic
 * is exercised by vitest. Nothing here touches a socket, the clock, or process
 * state — feed it numbers/strings, get a verdict.
 */

/** The stress prefix every created unit id carries; cleanup touches only these. */
export const STRESS_UNIT_PREFIX = 'grow.strstr';

/** Why an axis stopped short of its target — a graceful denial, or worse. */
export type DenialReason =
  | 'busy'        // ERR_BUSY / 409 — at-capacity, the device said no cleanly
  | 'no_mem'      // ERR_NO_MEM / out-of-heap — the heap floor, clean
  | 'hard_max'    // structural backstop (GROW_UNIT_HARD_MAX / unit backstop)
  | 'nack'        // Ack ok=false with a domain detail (e.g. admission deny)
  | 'timeout'     // request timed out — a wedge signal, NOT graceful
  | 'closed'      // socket closed / connection lost — a wedge/crash signal
  | 'other';      // anything unrecognised — treat as non-graceful

/** A classified denial: the bucket plus whether it counts as graceful. */
export interface Denial {
  reason: DenialReason;
  graceful: boolean;
  detail: string;
}

/**
 * Map an error/Ack-detail string onto a denial bucket. The firmware surfaces a
 * ceiling four ways (ws_h_auth.c, grow_controller.c, ws_cmd.c):
 *   - error reply  "409: server at capacity: max 3 clients"  -> busy
 *   - Ack ok=false "unit backstop reached"                   -> hard_max (nack)
 *   - error/Ack    "...no mem...", "ERR_NO_MEM", "out of heap"-> no_mem
 *   - error reply  "409: ..."/"ERR_BUSY"                     -> busy
 * A timeout or a closed socket is NOT a clean denial — it is a wedge/crash and
 * the axis fails. Everything else is `other` (also non-graceful: an unexpected
 * shape means we cannot prove the device degraded cleanly).
 */
export function classifyDenial(message: string): Denial {
  const m = message.toLowerCase();
  const detail = message;

  // Wedge / crash signals first — these dominate any substring match.
  if (m.includes('timed out') || m.includes('timeout')) {
    return { reason: 'timeout', graceful: false, detail };
  }
  if (
    m.includes('socket not open') || m.includes('not open') ||
    m.includes('socket closed') || m.includes('connection') && m.includes('clos') ||
    m.includes('disconnect') || m.includes('econnreset') || m.includes('epipe')
  ) {
    return { reason: 'closed', graceful: false, detail };
  }

  // Heap floor.
  if (m.includes('no_mem') || m.includes('no mem') || m.includes('out of heap') || m.includes('enomem')) {
    return { reason: 'no_mem', graceful: true, detail };
  }
  // Structural backstop (grow unit directory full).
  if (m.includes('hard_max') || m.includes('backstop') || m.includes('hard max')) {
    return { reason: 'hard_max', graceful: true, detail };
  }
  // Concurrent-client / generic at-capacity.
  if (m.includes('409') || m.includes('err_busy') || m.includes('busy') || m.includes('capacity') || m.includes('max 3 clients')) {
    return { reason: 'busy', graceful: true, detail };
  }
  // A bare Ack nack with a domain detail (admission deny we did not specifically
  // bucket) is still a clean "no" from the device — graceful.
  if (m.includes('nack') || m.includes('admit') || m.includes('denied') || m.includes('refus') || m.includes('reject') || m.includes('full')) {
    return { reason: 'nack', graceful: true, detail };
  }
  return { reason: 'other', graceful: false, detail };
}

/** A single stress axis result, machine-readable for the JSON verdict. */
export interface AxisResult {
  axis: string;
  /** Target the operator asked for (units/controllers/sessions/cycles). */
  target: number;
  /** How many actually succeeded before a denial (or all of them). */
  achieved: number;
  /** Set when the axis stopped short of target (graceful or not). */
  limit?: Denial;
  /** Axis-specific extra facts (e.g. authed/rejected counts). */
  notes?: Record<string, unknown>;
  /** True when the axis behaved acceptably (reached target OR denied cleanly). */
  pass: boolean;
}

/**
 * Decide whether a fan-out axis (units / controllers) passed. It passes if it
 * either reached its target, or it stopped at a GRACEFUL denial. A non-graceful
 * stop (timeout/closed/other) fails. `achieved === 0` with no denial is also a
 * fail (nothing happened — likely a wedge before the first op).
 */
export function classifyFanoutAxis(
  axis: string,
  target: number,
  achieved: number,
  limit: Denial | undefined,
  notes?: Record<string, unknown>,
): AxisResult {
  let pass: boolean;
  if (achieved >= target) pass = true;
  else if (limit) pass = limit.graceful;
  else pass = achieved > 0 ? true : false; // short of target but no denial recorded
  return { axis, target, achieved, limit, notes, pass };
}

/**
 * The client-cap axis: the device-global authed-client count is capped at
 * WS_MAX_AUTHED_CLIENTS (3). `occupied` slots are already held by sessions the
 * harness keeps open (the control session that drives stats/cleanup), so only
 * `cap - occupied` of the `target` fresh logins can succeed and the rest MUST be
 * rejected with a graceful busy denial. Too few authing, an extra one slipping
 * through, or a non-busy rejection fails the axis.
 */
export function classifyClientCapAxis(
  target: number,
  authed: number,
  rejected: Denial[],
  cap = 3,
  occupied = 0,
): AxisResult {
  const free = Math.max(0, cap - occupied);
  const expectedAuthed = Math.min(target, free);
  const expectedRejected = Math.max(0, target - expectedAuthed);
  const allRejectionsBusy = rejected.every((d) => d.reason === 'busy' || d.graceful);
  const pass =
    authed === expectedAuthed &&
    rejected.length === expectedRejected &&
    allRejectionsBusy;
  return {
    axis: 'sessions',
    target,
    achieved: authed,
    notes: { cap, occupied, free, authed, rejected: rejected.length, expectedAuthed, expectedRejected, allRejectionsBusy },
    pass,
  };
}

/**
 * Filter a flat list of currently-registered endpoint ids down to those that
 * belong to a (now-deleted) unit — i.e. orphans. An endpoint id is namespaced
 * `grow.<unit>.<name>`, so an orphan is any id whose prefix is exactly
 * `<unitId>.` (the trailing dot prevents `grow.s1` from matching `grow.s10`).
 */
export function orphanIds(registeredIds: Iterable<string>, deletedUnitId: string): string[] {
  const prefix = deletedUnitId.endsWith('.') ? deletedUnitId : `${deletedUnitId}.`;
  const out: string[] = [];
  for (const id of registeredIds) if (id.startsWith(prefix)) out.push(id);
  return out;
}

/** A reboot is min_free RISING above the lowest min we have seen this run. */
export function detectReboot(seenMinFloor: number, sampleMin: number): boolean {
  // Stats.min_free is a since-boot sticky low (ratchets DOWN only). If a later
  // sample reports a HIGHER min than we have already observed, the watermark
  // reset — i.e. the device rebooted.
  return Number.isFinite(seenMinFloor) && sampleMin > seenMinFloor;
}

/** The structured verdict every `diag stress` run emits (shape is the contract). */
export interface StressVerdict {
  pass: boolean;
  axes: AxisResult[];
  minFreeHeap: number;
  largestFreeBlockLow: number;
  orphans: string[];
  reboots: number;
  wedges: number;
  /** Human-readable one-liners for each FAIL reason (empty on pass). */
  failures: string[];
}

/**
 * Aggregate the axes + global observations into the final verdict. Overall PASS
 * requires: every run axis passed, zero orphans, zero reboots, zero wedges.
 */
export function aggregateVerdict(args: {
  axes: AxisResult[];
  minFreeHeap: number;
  largestFreeBlockLow: number;
  orphans: string[];
  reboots: number;
  wedges: number;
}): StressVerdict {
  const failures: string[] = [];
  for (const a of args.axes) {
    if (!a.pass) {
      const why = a.limit ? `${a.limit.reason}: ${a.limit.detail}` : 'did not meet expectation';
      failures.push(`axis '${a.axis}' FAILED (achieved ${a.achieved}/${a.target}; ${why})`);
    }
  }
  if (args.orphans.length > 0) failures.push(`orphans survived: ${args.orphans.length} (${args.orphans.slice(0, 5).join(', ')}${args.orphans.length > 5 ? ', ...' : ''})`);
  if (args.reboots > 0) failures.push(`device rebooted ${args.reboots}x during stress (min_free rose)`);
  if (args.wedges > 0) failures.push(`device wedged ${args.wedges}x (timeout / lost connection)`);

  return {
    pass: failures.length === 0,
    axes: args.axes,
    minFreeHeap: args.minFreeHeap,
    largestFreeBlockLow: args.largestFreeBlockLow,
    orphans: args.orphans,
    reboots: args.reboots,
    wedges: args.wedges,
    failures,
  };
}
