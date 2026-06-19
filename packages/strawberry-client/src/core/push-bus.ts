/**
 * PushBus — framework-free typed emitter for the device's push topics.
 *
 * Extracts ws.service.ts's dispatch() topic switch (:275-308) and the
 * applyStatsFast StatsFast-onto-last-full-Stats join (:316-335), dropping every
 * RxJS Subject for plain on(topic, cb)/off callbacks. The lastFullStats
 * reference is kept internally so a compact StatsFast frame is materialized into
 * a full Stats before emit, exactly as the SPA did — every 'stats' consumer sees
 * a coherent Stats and needs no StatsFast awareness.
 *
 * Fan-out semantics preserved: `ioValues` emits one 'ioValue' per entry, and
 * `logBatch` emits one 'log' per LogEntry, matching the SPA's per-entry fan-out.
 */
import type {
  ServerMessage,
  SensorSnapshot,
  Stats,
  StatsFast,
  TaskInfo,
  LogEntry,
  OwScanState,
  MbScanState,
  OtaProgress,
  IoValue,
  IoStruct,
  GrowConfig,
  ZbSpectrumFrame,
  ControllerEvent,
  CtrlGraphChanged,
  CtrlOutValsPush,
  TimeStatus,
  CanObserve,
} from '../proto/messages.js';

/** topic name -> payload type for `on`/`off`. */
export interface PushEventMap {
  snapshot: SensorSnapshot;
  stats: Stats;
  log: LogEntry;
  owScan: OwScanState;
  mbScan: MbScanState;
  ota: OtaProgress;
  ioValue: IoValue;
  ioStruct: IoStruct;
  growConfig: GrowConfig;
  zbSpectrum: ZbSpectrumFrame;
  ctrlEvent: ControllerEvent;
  ctrlGraphChanged: CtrlGraphChanged;
  ctrlOutVals: CtrlOutValsPush;
  timeStatus: TimeStatus;
  canObserve: CanObserve;
}

export type PushTopic = keyof PushEventMap;
export type PushHandler<K extends PushTopic> = (payload: PushEventMap[K]) => void;

export class PushBus {
  private readonly handlers = new Map<PushTopic, Set<(p: unknown) => void>>();
  /** Last full Stats frame — the name/static reference a StatsFast joins against. */
  private lastFullStats: Stats | null = null;

  on<K extends PushTopic>(topic: K, cb: PushHandler<K>): this {
    let set = this.handlers.get(topic);
    if (!set) { set = new Set(); this.handlers.set(topic, set); }
    set.add(cb as (p: unknown) => void);
    return this;
  }

  off<K extends PushTopic>(topic: K, cb: PushHandler<K>): this {
    this.handlers.get(topic)?.delete(cb as (p: unknown) => void);
    return this;
  }

  private emit<K extends PushTopic>(topic: K, payload: PushEventMap[K]): void {
    const set = this.handlers.get(topic);
    if (!set) return;
    for (const cb of set) cb(payload);
  }

  /**
   * Route a decoded ServerMessage payload to the right topic. Returns true if it
   * matched a push topic (so the caller can know it was a push, not a reply).
   */
  dispatch(msg: ServerMessage): boolean {
    switch (msg.payload.oneofKind) {
      case 'snapshot': this.emit('snapshot', msg.payload.snapshot); return true;
      case 'stats':
        this.lastFullStats = msg.payload.stats;
        this.emit('stats', msg.payload.stats);
        return true;
      case 'statsFast': this.applyStatsFast(msg.payload.statsFast); return true;
      case 'logBatch':
        for (const e of msg.payload.logBatch.entries) this.emit('log', e);
        return true;
      case 'owScan': this.emit('owScan', msg.payload.owScan); return true;
      case 'mbScan': this.emit('mbScan', msg.payload.mbScan); return true;
      case 'ota': this.emit('ota', msg.payload.ota); return true;
      case 'ioValue': this.emit('ioValue', msg.payload.ioValue); return true;
      case 'ioValues':
        for (const v of msg.payload.ioValues.values) this.emit('ioValue', v);
        return true;
      case 'ioStruct': this.emit('ioStruct', msg.payload.ioStruct); return true;
      case 'growConfig': this.emit('growConfig', msg.payload.growConfig); return true;
      case 'zbSpectrum': this.emit('zbSpectrum', msg.payload.zbSpectrum); return true;
      case 'ctrlEvent': this.emit('ctrlEvent', msg.payload.ctrlEvent); return true;
      case 'ctrlGraphChanged': this.emit('ctrlGraphChanged', msg.payload.ctrlGraphChanged); return true;
      case 'ctrlOutVals': this.emit('ctrlOutVals', msg.payload.ctrlOutVals); return true;
      case 'timeStatus': this.emit('timeStatus', msg.payload.timeStatus); return true;
      case 'canObserve': this.emit('canObserve', msg.payload.canObserve); return true;
      default: return false;
    }
  }

  /**
   * Merge a compact StatsFast frame onto the last full Stats frame: each task's
   * (cpu_permille<<16)|stack_hwm_words packs positionally against
   * lastFullStats.tasks. Without a full reference frame yet we drop it (the
   * firmware sends a full frame on subscribe and on any task-set change).
   */
  private applyStatsFast(f: StatsFast): void {
    const base = this.lastFullStats;
    if (!base) return;
    const tasks: TaskInfo[] = base.tasks.map((t, i) => {
      const packed = i < f.task.length ? f.task[i] : 0;
      const permille = (packed >>> 16) & 0xffff;
      const hwm = packed & 0xffff;
      return { ...t, cpuPermille: permille, cpuPercent: permille / 10, stackHighWm: hwm };
    });
    this.emit('stats', {
      ...base,
      freeHeap: f.freeHeap,
      minFreeHeap: f.minFreeHeap,
      largestFreeBlock: f.largestFreeBlock,
      cpuPercentTotal: f.cpuPercentTotal,
      rssi: f.rssi,
      uptimeMs: f.uptimeMs,
      tasks,
    });
  }
}
