/**
 * `strawberry ota upload` — push firmware over WS.
 *
 *   --bin APP        app slot   (target 0, reboots)
 *   --spa-bin SPA    spa partn  (target 1, web UI applies on next page load)
 *   --combined IMG   fw+spa     (target 2, single mk_combined SBC1 stream, reboots)
 *
 * Replicates tools/ota_upload.py: OtaUploadBegin -> raw 0x01 chunk frames (the
 * device acks each with the next expected offset via the rid=0 OtaChunkAck path)
 * -> OtaUploadEnd. The reboot for app/combined drops the socket before the End
 * ack lands, which is treated as success — validate with `query ota` + `diag heap`
 * (dwell+3x) afterwards.
 */
import { openSync, readSync, fstatSync, closeSync } from 'node:fs';
import { otaBegin, otaChunk, otaEnd, OTA_TARGET_APP, OTA_TARGET_SPA, OTA_TARGET_COMBINED } from '../../api/commands.js';
import { printJson, printLine, CliError } from '../output.js';
import { flagBool, flagNum, flagStr, type ParsedArgs } from '../args.js';
import { openSession, dispose, type Session } from '../connect.js';

const CHUNK = 4096; // must match OTA_CHUNK_MAX in ws_dispatch.c
const COMBINED_MAGIC = 0x31434253; // 'SBC1' LE
const COMBINED_HDR = 12;

export async function cmdOta(p: ParsedArgs): Promise<void> {
  const sub = p.positionals[1];
  if (sub !== 'upload') throw new CliError('ota upload (--bin | --spa-bin | --combined) <file>');

  const appBin = flagStr(p, 'bin');
  const spaBin = flagStr(p, 'spa-bin');
  const combined = flagStr(p, 'combined');
  const chosen = [appBin, spaBin, combined].filter(Boolean);
  if (chosen.length !== 1) {
    throw new CliError('ota upload needs exactly one of --bin / --spa-bin / --combined');
  }

  const chunkTimeoutMs = (flagNum(p, 'chunk-timeout') ?? 15) * 1000;
  const session = await openSession(p);
  try {
    if (combined) await uploadCombined(session, combined, chunkTimeoutMs, p);
    else if (spaBin) await uploadOne(session, spaBin, OTA_TARGET_SPA, 'spa', chunkTimeoutMs, p);
    else await uploadOne(session, appBin!, OTA_TARGET_APP, 'app', chunkTimeoutMs, p);
  } finally {
    dispose(session);
  }
}

/** Single-image upload (app or spa). */
async function uploadOne(
  session: Session, path: string, target: number, label: string,
  chunkTimeoutMs: number, p: ParsedArgs,
): Promise<void> {
  const fd = openSync(path, 'r');
  try {
    const size = fstatSync(fd).size;
    progress(p, `[${label}] ${path} (${size} bytes)`);

    await otaBegin(session.client, { size, target });
    let offset = 0;
    const buf = Buffer.allocUnsafe(CHUNK);
    while (offset < size) {
      const n = readSync(fd, buf, 0, Math.min(CHUNK, size - offset), offset);
      offset = await otaChunk(session.client, offset, buf.subarray(0, n), chunkTimeoutMs);
      printPct(p, label, offset, size);
    }
    await finishUpload(session, label, target, p);
  } finally {
    closeSync(fd);
  }
}

/** Combined SBC1 [spa][app] stream (target 2). Offsets are payload-relative. */
async function uploadCombined(session: Session, path: string, chunkTimeoutMs: number, p: ParsedArgs): Promise<void> {
  const fd = openSync(path, 'r');
  try {
    const fsize = fstatSync(fd).size;
    const hdr = Buffer.allocUnsafe(COMBINED_HDR);
    readSync(fd, hdr, 0, COMBINED_HDR, 0);
    const magic = hdr.readUInt32LE(0);
    const appSize = hdr.readUInt32LE(4);
    const spaSize = hdr.readUInt32LE(8);
    if (magic !== COMBINED_MAGIC) {
      throw new CliError(`${path}: bad combined magic (run tools/mk_combined.py)`);
    }
    const payload = spaSize + appSize;
    if (COMBINED_HDR + payload !== fsize) {
      throw new CliError(`${path}: size mismatch hdr+${payload} != ${fsize}`);
    }
    progress(p, `[combined] ${path}: spa=${spaSize} + app=${appSize} = ${payload} bytes`);

    await otaBegin(session.client, { size: payload, target: OTA_TARGET_COMBINED, spaSize, appSize });
    let offset = 0;
    const buf = Buffer.allocUnsafe(CHUNK);
    while (offset < payload) {
      const n = readSync(fd, buf, 0, Math.min(CHUNK, payload - offset), COMBINED_HDR + offset);
      offset = await otaChunk(session.client, offset, buf.subarray(0, n), chunkTimeoutMs);
      printPct(p, offset <= spaSize ? 'spa' : 'app', offset, payload);
    }
    await finishUpload(session, 'combined', OTA_TARGET_COMBINED, p);
  } finally {
    closeSync(fd);
  }
}

async function finishUpload(session: Session, label: string, target: number, p: ParsedArgs): Promise<void> {
  try {
    await otaEnd(session.client, 30000);
    done(p, label, 'applied');
  } catch (e) {
    // app/combined reboot drops the socket before the End ack lands — success.
    if (target !== OTA_TARGET_SPA) {
      done(p, label, 'socket dropped (device rebooting)');
      return;
    }
    throw new CliError(`ota ${label} end failed: ${(e as Error).message}`);
  }
}

function progress(p: ParsedArgs, line: string): void {
  if (!flagBool(p, 'json')) printLine(line);
}

function printPct(p: ParsedArgs, zone: string, offset: number, total: number): void {
  if (flagBool(p, 'json')) return;
  const pct = Math.floor((offset * 100) / total);
  process.stdout.write(`\r[${zone}] ${pct}%  ${offset}/${total}   `);
  if (offset >= total) process.stdout.write('\n');
}

function done(p: ParsedArgs, label: string, message: string): void {
  if (flagBool(p, 'json')) printJson({ ok: true, target: label, message });
  else printLine(`[${label}] ${message}`);
}
