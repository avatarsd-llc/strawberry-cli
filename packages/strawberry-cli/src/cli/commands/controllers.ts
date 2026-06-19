/**
 * `strawberry controllers ...` — wire the controller dataflow graph.
 *
 *   graph-apply  land the whole dependency-ordered chunk atomically (creates all
 *                nodes then binds, rolls back on failure, idempotent re-bind)
 *   list         list live controllers (ControllerListReq)
 *   destroy      destroy one controller instance
 *
 * graph-apply reads a JSON array of nodes:
 *   [{ "kind": "...", "instanceId": "...", "params": "<base64>"?,
 *      "inputs": [{ "slot": 0, "ioId": "grow.1.temp" }],
 *      "outputs": [{ "slot": 0, "ioId": "grow.1.heater" }] }, ...]
 * The whole-unit apply can run past the generic window, so a longer --timeout-ms
 * is honoured on a loaded device.
 */
import { readFileSync } from 'node:fs';
import type { ControllerBinding, ControllerCreate } from '@avatarsd-llc/strawberry-client/proto';
import { ctrlGraphApply, ctrlDestroy, listControllers } from '@avatarsd-llc/strawberry-client';
import { printJson, printLine, CliError } from '../output.js';
import { flagBool, flagNum, flagStr, type ParsedArgs } from '../args.js';
import { openSession, dispose } from '../connect.js';

export async function cmdControllers(p: ParsedArgs): Promise<void> {
  const sub = p.positionals[1];
  switch (sub) {
    case 'graph-apply': return graphApply(p);
    case 'list': return list(p);
    case 'destroy': return destroy(p);
    default:
      throw new CliError('controllers <graph-apply|list|destroy>');
  }
}

interface NodeJson {
  kind: string;
  instanceId?: string;
  instance_id?: string;
  params?: string; // base64-encoded controller param blob
  inputs?: Array<{ slot: number; ioId?: string; io_id?: string }>;
  outputs?: Array<{ slot: number; ioId?: string; io_id?: string }>;
}

async function graphApply(p: ParsedArgs): Promise<void> {
  const file = flagStr(p, 'nodes');
  if (!file) throw new CliError('controllers graph-apply requires --nodes FILE.json');
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(file, 'utf8')); }
  catch (e) { throw new CliError(`cannot read nodes JSON: ${(e as Error).message}`); }

  const arr = Array.isArray(raw) ? raw : (raw as { nodes?: unknown }).nodes;
  if (!Array.isArray(arr)) throw new CliError('nodes JSON must be an array (or { "nodes": [...] })');

  const nodes: ControllerCreate[] = (arr as NodeJson[]).map((n, i) => {
    const instanceId = n.instanceId ?? n.instance_id;
    if (!n.kind || !instanceId) throw new CliError(`node[${i}] needs kind + instanceId`);
    return {
      kind: n.kind,
      instanceId,
      params: n.params ? new Uint8Array(Buffer.from(n.params, 'base64')) : new Uint8Array(0),
      inputs: bindings(n.inputs),
      outputs: bindings(n.outputs),
    };
  });

  const timeoutMs = flagNum(p, 'timeout-ms') ?? 30000;
  const session = await openSession(p);
  try {
    await ctrlGraphApply(session.client, nodes, timeoutMs);
    if (flagBool(p, 'json')) printJson({ ok: true, applied: nodes.length });
    else printLine(`graph applied: ${nodes.length} node(s)`);
  } finally {
    dispose(session);
  }
}

function bindings(raw?: Array<{ slot: number; ioId?: string; io_id?: string }>): ControllerBinding[] {
  if (!raw) return [];
  return raw.map((b) => ({ slot: b.slot, ioId: b.ioId ?? b.io_id ?? '' }));
}

async function list(p: ParsedArgs): Promise<void> {
  const session = await openSession(p);
  try {
    const cl = await listControllers(session.client);
    if (flagBool(p, 'json')) {
      printJson(cl.controllers.map((c) => ({
        instanceId: c.instanceId, kind: c.kindName, enabled: c.enabled,
        status: c.statusStr, inputs: c.inputs, outputs: c.outputs, builtin: c.isBuiltin,
      })));
    } else {
      for (const c of cl.controllers) {
        printLine(`${c.instanceId}\t${c.kindName}\t${c.enabled ? 'on' : 'off'}\t${c.statusStr}`);
      }
      if (cl.controllers.length === 0) printLine('(no controllers)');
    }
  } finally {
    dispose(session);
  }
}

async function destroy(p: ParsedArgs): Promise<void> {
  const id = flagStr(p, 'id') ?? p.positionals[2];
  if (!id) throw new CliError('controllers destroy requires --id <instance_id>');
  const session = await openSession(p);
  try {
    await ctrlDestroy(session.client, id);
    if (flagBool(p, 'json')) printJson({ ok: true, destroyed: id });
    else printLine(`destroyed: ${id}`);
  } finally {
    dispose(session);
  }
}
