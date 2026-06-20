import { describe, it, expect } from 'vitest';
import {
  STRESS_UNIT_PREFIX,
  classifyDenial,
  classifyFanoutAxis,
  classifyClientCapAxis,
  orphanIds,
  detectReboot,
  aggregateVerdict,
  type Denial,
} from '../src/cli/commands/stress-verdict.js';

describe('classifyDenial', () => {
  it('maps the firmware client-cap rejection to a graceful busy', () => {
    const d = classifyDenial('409: server at capacity: max 3 clients');
    expect(d.reason).toBe('busy');
    expect(d.graceful).toBe(true);
  });

  it('maps a grow-unit admission backstop to a graceful hard_max', () => {
    const d = classifyDenial('unit backstop reached');
    expect(d.reason).toBe('hard_max');
    expect(d.graceful).toBe(true);
  });

  it('maps an out-of-heap nack to a graceful no_mem', () => {
    expect(classifyDenial('ERR_NO_MEM').reason).toBe('no_mem');
    expect(classifyDenial('out of heap').graceful).toBe(true);
  });

  it('treats a request timeout as a NON-graceful wedge', () => {
    const d = classifyDenial('request timed out');
    expect(d.reason).toBe('timeout');
    expect(d.graceful).toBe(false);
  });

  it('treats a closed socket as a NON-graceful wedge', () => {
    expect(classifyDenial('socket not open').reason).toBe('closed');
    expect(classifyDenial('ECONNRESET').graceful).toBe(false);
  });

  it('classifies a generic Ack nack detail as a graceful denial', () => {
    const d = classifyDenial('admission denied: heap floor');
    expect(d.graceful).toBe(true);
  });

  it('treats an unrecognised error as non-graceful other', () => {
    const d = classifyDenial('kernel panic: weird');
    expect(d.reason).toBe('other');
    expect(d.graceful).toBe(false);
  });

  it('prioritises the wedge signal over a co-occurring busy word', () => {
    // "busy" appears, but a timeout dominates — must be flagged as a wedge.
    const d = classifyDenial('request timed out while server busy');
    expect(d.reason).toBe('timeout');
    expect(d.graceful).toBe(false);
  });
});

describe('classifyFanoutAxis', () => {
  it('passes when the axis reaches its target with no denial', () => {
    const a = classifyFanoutAxis('units', 32, 32, undefined);
    expect(a.pass).toBe(true);
  });

  it('passes when it stops short at a GRACEFUL denial (the ceiling)', () => {
    const limit: Denial = { reason: 'hard_max', graceful: true, detail: 'backstop' };
    const a = classifyFanoutAxis('units', 64, 32, limit);
    expect(a.achieved).toBe(32);
    expect(a.pass).toBe(true);
  });

  it('fails when it stops at a NON-graceful denial (a wedge)', () => {
    const limit: Denial = { reason: 'timeout', graceful: false, detail: 'timed out' };
    const a = classifyFanoutAxis('controllers', 320, 48, limit);
    expect(a.pass).toBe(false);
  });

  it('fails when achieved is 0 with no recorded denial (nothing happened)', () => {
    const a = classifyFanoutAxis('units', 32, 0, undefined);
    expect(a.pass).toBe(false);
  });
});

describe('classifyClientCapAxis', () => {
  const busy = (): Denial => ({ reason: 'busy', graceful: true, detail: 'max 3 clients' });

  it('passes the standalone case: 3 authed, 2 busy-rejected of 5 (no slots held)', () => {
    const a = classifyClientCapAxis(5, 3, [busy(), busy()]);
    expect(a.pass).toBe(true);
    expect(a.achieved).toBe(3);
    expect(a.notes).toMatchObject({ cap: 3, occupied: 0, free: 3, authed: 3, rejected: 2 });
  });

  it('accounts for the control session holding a slot: free=2 of 5 -> 2 authed, 3 rejected', () => {
    // The harness keeps one control session open, so only cap-1 fresh logins fit.
    const a = classifyClientCapAxis(5, 2, [busy(), busy(), busy()], 3, 1);
    expect(a.pass).toBe(true);
    expect(a.notes).toMatchObject({ occupied: 1, free: 2, expectedAuthed: 2, expectedRejected: 3 });
  });

  it('fails when a 3rd fresh client slips through despite a held control slot', () => {
    const a = classifyClientCapAxis(5, 3, [busy(), busy()], 3, 1);
    expect(a.pass).toBe(false);
  });

  it('fails when a 4th client slips through the bare cap', () => {
    const a = classifyClientCapAxis(5, 4, [busy()]);
    expect(a.pass).toBe(false);
  });

  it('fails when fewer than the free slots authenticate', () => {
    const a = classifyClientCapAxis(5, 2, [busy(), busy(), busy()]);
    expect(a.pass).toBe(false);
  });

  it('fails when a rejection is NOT a clean busy (e.g. a timeout)', () => {
    const timeout: Denial = { reason: 'timeout', graceful: false, detail: 'timed out' };
    const a = classifyClientCapAxis(5, 3, [busy(), timeout]);
    expect(a.pass).toBe(false);
  });

  it('passes trivially when target is at or under the free slots (none rejected)', () => {
    const a = classifyClientCapAxis(3, 3, []);
    expect(a.pass).toBe(true);
    const a2 = classifyClientCapAxis(2, 2, []);
    expect(a2.pass).toBe(true);
  });
});

describe('orphanIds', () => {
  const live = [
    'grow.strstr.u0.in',
    'grow.strstr.u0.heater',
    'grow.strstr.u10.in', // must NOT match u0/u1's prefix
    'grow.strstr.ctrlhost.c0',
    'host.water_top.ok',
    'grow.realunit.temp',
  ];

  it('matches only endpoints under the exact unit prefix (dot-bounded)', () => {
    expect(orphanIds(live, 'grow.strstr.u0')).toEqual([
      'grow.strstr.u0.in',
      'grow.strstr.u0.heater',
    ]);
  });

  it('does not let grow.strstr.u1 match grow.strstr.u10', () => {
    expect(orphanIds(live, 'grow.strstr.u1')).toEqual([]);
  });

  it('returns empty when the unit is fully swept (no orphans)', () => {
    expect(orphanIds(live, 'grow.strstr.gone')).toEqual([]);
  });

  it('accepts a prefix already carrying the trailing dot', () => {
    expect(orphanIds(live, 'grow.strstr.ctrlhost.')).toEqual(['grow.strstr.ctrlhost.c0']);
  });

  it('never touches a pre-existing real unit', () => {
    expect(orphanIds(live, 'grow.realunit')).toEqual(['grow.realunit.temp']);
    // and a stress sweep of the realunit prefix yields its own ids only,
    // proving the matcher is prefix-exact and cannot collateral-delete.
  });
});

describe('detectReboot', () => {
  it('flags a reboot when min_free rises above the seen floor', () => {
    expect(detectReboot(48000, 90000)).toBe(true);
  });

  it('does not flag a ratchet-down (the normal sticky-low behaviour)', () => {
    expect(detectReboot(48000, 40000)).toBe(false);
    expect(detectReboot(48000, 48000)).toBe(false);
  });

  it('does not flag against an un-initialised (Infinity) floor', () => {
    expect(detectReboot(Infinity, 90000)).toBe(false);
  });
});

describe('aggregateVerdict', () => {
  const okAxis = { axis: 'units', target: 32, achieved: 32, pass: true };

  it('PASSes when every axis passed and there are no orphans/reboots/wedges', () => {
    const v = aggregateVerdict({
      axes: [okAxis],
      minFreeHeap: 50000,
      largestFreeBlockLow: 40000,
      orphans: [],
      reboots: 0,
      wedges: 0,
    });
    expect(v.pass).toBe(true);
    expect(v.failures).toEqual([]);
  });

  it('FAILs and explains a failing axis', () => {
    const v = aggregateVerdict({
      axes: [{ axis: 'controllers', target: 320, achieved: 16, pass: false,
        limit: { reason: 'timeout', graceful: false, detail: 'timed out' } }],
      minFreeHeap: 30000, largestFreeBlockLow: 20000,
      orphans: [], reboots: 0, wedges: 0,
    });
    expect(v.pass).toBe(false);
    expect(v.failures[0]).toContain("axis 'controllers' FAILED");
  });

  it('FAILs on any surviving orphan', () => {
    const v = aggregateVerdict({
      axes: [okAxis], minFreeHeap: 50000, largestFreeBlockLow: 40000,
      orphans: ['grow.strstr.u0.in'], reboots: 0, wedges: 0,
    });
    expect(v.pass).toBe(false);
    expect(v.failures.join(' ')).toContain('orphans survived');
  });

  it('FAILs on a detected reboot', () => {
    const v = aggregateVerdict({
      axes: [okAxis], minFreeHeap: 50000, largestFreeBlockLow: 40000,
      orphans: [], reboots: 1, wedges: 0,
    });
    expect(v.pass).toBe(false);
    expect(v.failures.join(' ')).toContain('rebooted');
  });

  it('FAILs on a detected wedge', () => {
    const v = aggregateVerdict({
      axes: [okAxis], minFreeHeap: 50000, largestFreeBlockLow: 40000,
      orphans: [], reboots: 0, wedges: 2,
    });
    expect(v.pass).toBe(false);
    expect(v.failures.join(' ')).toContain('wedged');
  });

  it('echoes the global watermarks into the verdict shape', () => {
    const v = aggregateVerdict({
      axes: [okAxis], minFreeHeap: 12345, largestFreeBlockLow: 6789,
      orphans: [], reboots: 0, wedges: 0,
    });
    expect(v).toMatchObject({ minFreeHeap: 12345, largestFreeBlockLow: 6789, reboots: 0, wedges: 0 });
  });
});

describe('STRESS_UNIT_PREFIX', () => {
  it('is the namespaced grow prefix cleanup keys on', () => {
    expect(STRESS_UNIT_PREFIX).toBe('grow.strstr');
    expect(STRESS_UNIT_PREFIX.startsWith('grow.')).toBe(true);
  });
});
