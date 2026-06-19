/**
 * `strawberry wg apply|disable|status` — provision the device WireGuard client
 * from a wg-quick .conf (parse [Interface]/[Peer], derive the on-link netmask
 * from the AllowedIPs subnet) and poll WgStatus until the peer comes up. The
 * fleet-join step (supersedes tools/wg_provision.py).
 */
import { Query_What, WgState, type WgStatus } from '@avatarsd-llc/strawberry-client/proto';
import { readFileSync } from 'node:fs';
import { printJson, printLine, CliError } from '../output.js';
import { flagBool, flagNum, flagStr, type ParsedArgs } from '../args.js';
import { openSession, dispose } from '../connect.js';
import { parseWgConf } from '../wg-conf.js';

export async function cmdWg(p: ParsedArgs): Promise<void> {
  const sub = p.positionals[1];
  switch (sub) {
    case 'apply': case 'set': return wgApply(p);
    case 'disable': return wgDisable(p);
    case 'status': return wgStatus(p);
    default:
      throw new CliError('wg <apply|disable|status>');
  }
}

async function wgApply(p: ParsedArgs): Promise<void> {
  const confPath = flagStr(p, 'conf');
  if (!confPath) throw new CliError('wg apply requires --conf <wg-quick.conf>');
  let conf;
  try { conf = parseWgConf(readFileSync(confPath, 'utf8')); }
  catch (e) { throw new CliError(`wg conf parse failed: ${(e as Error).message}`); }

  const session = await openSession(p);
  try {
    await session.client.sendExpectAck({ oneofKind: 'wgSet', wgSet: conf });
    if (flagBool(p, 'json')) {
      printJson({ ok: true, applied: { ...conf, privateKey: conf.privateKey ? '<redacted>' : '' } });
    } else {
      printLine(`wg applied: local=${conf.localIp}/${conf.localNetmask} peer=${conf.peerEndpoint}:${conf.peerPort}`);
    }
  } finally {
    dispose(session);
  }
}

async function wgDisable(p: ParsedArgs): Promise<void> {
  const session = await openSession(p);
  try {
    // Empty private_key leaves the stored key untouched; enabled=false tears it down.
    await session.client.sendExpectAck({
      oneofKind: 'wgSet',
      wgSet: {
        enabled: false, privateKey: '', peerPublicKey: '', localIp: '',
        localNetmask: '', peerEndpoint: '', peerPort: 0, keepaliveS: 0,
      },
    });
    if (flagBool(p, 'json')) printJson({ ok: true, message: 'wg disabled' });
    else printLine('wg disabled');
  } finally {
    dispose(session);
  }
}

async function wgStatus(p: ParsedArgs): Promise<void> {
  const watchS = flagNum(p, 'watch');
  const session = await openSession(p);
  try {
    const deadline = watchS !== undefined ? Date.now() + watchS * 1000 : 0;
    let last: WgStatus | null = null;
    for (;;) {
      const reply = await session.client.query<'wgStatus'>(Query_What.WG_STATUS);
      last = reply.oneofKind === 'wgStatus' ? reply.wgStatus : null;
      if (!last) throw new CliError('wg status query returned no WgStatus');
      const up = last.state === WgState.WGSTATE_UP;
      if (!flagBool(p, 'json')) {
        printLine(`wg state=${WgState[last.state]} enabled=${last.enabled} configured=${last.configured} retries=${last.retryCount} since=${last.stateSinceS}s`);
      }
      if (up || deadline === 0 || Date.now() >= deadline) {
        if (flagBool(p, 'json')) printJson({ state: WgState[last.state], up, status: last });
        if (deadline !== 0 && !up) process.exitCode = 3;
        return;
      }
      await sleep(2000);
    }
  } finally {
    dispose(session);
  }
}

function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }
