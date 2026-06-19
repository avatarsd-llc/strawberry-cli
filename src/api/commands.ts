/**
 * Typed command/query helpers over a DeviceClient.
 *
 * These are thin, 1:1-with-proto builders for the most-used command paths
 * (the constructor + provisioning + OTA surfaces). Each returns the same
 * promise the underlying send/sendExpectAck does, so callers stay close to the
 * wire while getting a named, typed entry point. They use `PartialMessage<T>`
 * so a caller supplies only the meaningful fields and protobuf-ts fills the
 * defaults — exactly how the SPA services build these messages.
 *
 * This is intentionally NOT exhaustive over all 64 oneof variants yet; the full
 * api/* fan-out (auth/query/grow/controllers/io/ota/...) lands behind subpath
 * modules in a later phase. `DeviceClient.send` remains the escape hatch for any
 * variant not yet wrapped.
 */
import type { PartialMessage } from '@protobuf-ts/runtime';
import type { DeviceClient } from '../core/device-client.js';
import {
  Query_What,
  GrowUnit,
  type Ack,
  type ControllerCreate,
  type GrowUserIoDesc,
  type ParamDef,
  type GrowProfileStage,
  type ControllerList,
  type GrowConfig,
} from '../proto/messages.js';

/** Create or update a cultivation unit (GrowUnitSet, tag 42). */
export function growUnitSet(c: DeviceClient, unit: PartialMessage<GrowUnit>, timeoutMs?: number): Promise<Ack> {
  // GrowUnit.create fills proto defaults (profile_id/flags/... = 0) so a partial
  // {id,name,kind,active} encodes — a raw partial leaves non-optional uint32s
  // undefined and the codec rejects them ("invalid uint 32: undefined").
  return c.sendExpectAck({ oneofKind: 'growUnitSet', growUnitSet: { unit: GrowUnit.create(unit) } }, timeoutMs);
}

/** Remove a cultivation unit by id (GrowUnitRemove, tag 43). */
export function growUnitRemove(c: DeviceClient, id: string, timeoutMs?: number): Promise<Ack> {
  return c.sendExpectAck({ oneofKind: 'growUnitRemove', growUnitRemove: { id } }, timeoutMs);
}

/** Push a unit's working schedule (GrowScheduleSet, tag 69). */
export function growScheduleSet(
  c: DeviceClient,
  schedule: { id: string; params: ParamDef[]; stages: GrowProfileStage[]; derivedMask?: number },
  timeoutMs?: number,
): Promise<Ack> {
  return c.sendExpectAck({ oneofKind: 'growScheduleSet', growScheduleSet: schedule }, timeoutMs);
}

/**
 * Apply the controller dataflow graph atomically (CtrlGraphApply, tag 75).
 * Creates all nodes then binds; rolls back on failure; idempotent re-bind. The
 * whole-unit apply can run well past the generic window, so pass a longer
 * timeoutMs on a loaded device.
 */
export function ctrlGraphApply(
  c: DeviceClient,
  nodes: PartialMessage<ControllerCreate>[],
  timeoutMs?: number,
): Promise<Ack> {
  return c.sendExpectAck(
    { oneofKind: 'ctrlGraphApply', ctrlGraphApply: { nodes: nodes as ControllerCreate[] } },
    timeoutMs,
  );
}

/** Add a user-defined IO endpoint to a unit (GrowUserIoAdd, tag 66). */
export function growUserIoAdd(
  c: DeviceClient,
  unitId: string,
  desc: PartialMessage<GrowUserIoDesc>,
  scope?: number,
  timeoutMs?: number,
): Promise<Ack> {
  return c.sendExpectAck(
    { oneofKind: 'growUserIoAdd', growUserIoAdd: { unitId, desc: desc as GrowUserIoDesc, scope } },
    timeoutMs,
  );
}

/** Remove a user-defined IO endpoint (GrowUserIoRemove, tag 67). */
export function growUserIoRemove(c: DeviceClient, unitId: string, name: string, timeoutMs?: number): Promise<Ack> {
  return c.sendExpectAck({ oneofKind: 'growUserIoRemove', growUserIoRemove: { unitId, name } }, timeoutMs);
}

/** Destroy a single controller instance (ControllerDestroy, tag 59). */
export function ctrlDestroy(c: DeviceClient, instanceId: string, timeoutMs?: number): Promise<Ack> {
  return c.sendExpectAck({ oneofKind: 'ctrlDestroy', ctrlDestroy: { instanceId } }, timeoutMs);
}

/** List all controllers (ControllerListReq, tag 56 -> ControllerList, payload 34). */
export async function listControllers(c: DeviceClient, timeoutMs?: number): Promise<ControllerList> {
  const reply = await c.send({ oneofKind: 'ctrlListReq', ctrlListReq: {} }, timeoutMs);
  if (reply.payload.oneofKind === 'ctrlList') return reply.payload.ctrlList;
  if (reply.payload.oneofKind === 'error') throw new Error(reply.payload.error.detail || 'ctrl list failed');
  throw new Error(`unexpected reply: ${reply.payload.oneofKind}`);
}

/** Pull the grow config snapshot (Query WHAT_GROW_CONFIG -> GrowConfig). */
export async function getGrowConfig(c: DeviceClient): Promise<GrowConfig> {
  const reply = await c.query<'growConfig'>(Query_What.GROW_CONFIG);
  if (reply.oneofKind === 'growConfig') return reply.growConfig;
  throw new Error('grow config query failed');
}

/* ------------ OTA upload (push, target 0/1/2) ------------ */

export const OTA_TARGET_APP = 0;
export const OTA_TARGET_SPA = 1;
export const OTA_TARGET_COMBINED = 2;

/**
 * Begin a push OTA (OtaUploadBegin, tag 38). target: 0 app / 1 spa / 2 combined.
 *
 * The firmware replies to OtaUploadBegin with a chunk-ack(offset=0) carrying the
 * request's rid — NOT an Ack (ws_ota_upload.c: "The begin reply is a
 * chunk-ack(offset=0), not an Ack"). So this uses send() and tolerates the
 * otaChunkAck reply, returning the start offset (0 on success) for the caller to
 * seed its chunk loop. An Ack/error shape is also accepted defensively.
 */
export async function otaBegin(
  c: DeviceClient,
  args: { size: number; target: number; spaSize?: number; appSize?: number },
  timeoutMs?: number,
): Promise<number> {
  const reply = await c.send({
    oneofKind: 'otaUploadBegin',
    otaUploadBegin: {
      size: args.size,
      target: args.target,
      spaSize: args.spaSize ?? 0,
      appSize: args.appSize ?? 0,
    },
  }, timeoutMs);
  const r = reply.payload;
  if (r.oneofKind === 'otaChunkAck') return Number(r.otaChunkAck.nextOffset);
  if (r.oneofKind === 'ack') {
    if (!r.ack.ok) throw new Error(r.ack.detail || 'nack');
    return 0;
  }
  if (r.oneofKind === 'error') throw new Error(`${r.error.code}: ${r.error.detail}`);
  throw new Error(`unexpected reply: ${r.oneofKind}`);
}

/** Send one raw OTA chunk; resolves the next expected offset (rid=0 OtaChunkAck). */
export function otaChunk(c: DeviceClient, offset: number, data: Uint8Array, timeoutMs?: number): Promise<number> {
  return c.sendChunkRaw(offset, data, timeoutMs);
}

/** Finish a push OTA (OtaUploadEnd, tag 40). The device applies/reboots. */
export function otaEnd(c: DeviceClient, timeoutMs?: number): Promise<Ack> {
  return c.sendExpectAck({ oneofKind: 'otaUploadEnd', otaUploadEnd: {} }, timeoutMs);
}

/** Abort an in-progress push OTA (OtaUploadAbort, tag 41). */
export function otaAbort(c: DeviceClient, timeoutMs?: number): Promise<Ack> {
  return c.sendExpectAck({ oneofKind: 'otaUploadAbort', otaUploadAbort: {} }, timeoutMs);
}
