#!/usr/bin/env node
/**
 * mock-board.mjs — a protocol-faithful SIL stand-in for the Gorshok-v4 firmware
 * WS+protobuf backend.
 *
 * WHY THIS EXISTS
 * ---------------
 * The real firmware WS server is ESP-IDF / lwIP and does NOT run on host (the
 * firmware host_test stubs esp_http_server + sockets). So there is no way to run
 * the actual backend in CI. This mock speaks the SAME wire contract the firmware
 * does so the strawberry-cli / DeviceClient can be exercised end-to-end without
 * hardware:
 *
 *   - the 1-byte client frame discriminator (0x00 = ClientMessage protobuf body,
 *     0x01 = raw OTA chunk) — wire/framing.ts
 *   - bare ServerMessage protobuf server->client (no discriminator)
 *   - the canonical protobuf-ts codec, imported from the built ../dist so the
 *     mock and the library agree byte-for-byte on the schema
 *
 * It deliberately reproduces the documented FIRMWARE QUIRKS (HIL-FINDINGS.md) so
 * SIL and HIL agree:
 *
 *   B1  auth tokens are SOCKET-BOUND. A token issued on one connection is revoked
 *       when that socket closes; AuthResume on a NEW connection returns
 *       ERR_AUTH_EXPIRED (419, "token expired"). ws_h_auth.c:98-101 +
 *       on_socket_close.
 *   B2  stats is PUSH-ONLY: Query{WHAT_STATS} returns error 400 "unknown query"
 *       (ws_dispatch.c:226 — there is no WHAT_STATS case). Snapshot, by contrast,
 *       IS a real query (ws_dispatch.c:209) and returns a SensorSnapshot.
 *   B7+ grow unit-set with active=false does NOT register a unit
 *       (grow_controller.c:426-435 only creates on cfg.active). A later
 *       grow user-io-add to that id then returns ERR_NOT_FOUND (0x105) because
 *       find_unit_by_id misses — exactly the "OPEN" finding. Modeled below.
 *
 * No runtime dependency on the `ws` package: a minimal RFC6455 server is built
 * from node:http + node:crypto so the mock runs in node:20-slim with zero deps.
 *
 * NOT a behavioral simulator: canned states are returned for the read-only
 * queries; the mutating grow/user-io surface keeps a tiny in-memory unit table so
 * the create -> add -> list -> remove lifecycle (and the active=false ERR_NOT_FOUND
 * quirk) behave like the firmware.
 */
import { createServer } from 'node:http';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = join(HERE, '..', 'dist', 'index.mjs');

/* The codec comes from the BUILT library so the mock cannot drift from the
   schema the CLI actually encodes/decodes. `npm run build` must have run. */
const {
  ClientMessage, ServerMessage, Query_What, ErrCode, GrowKind,
} = await import(DIST);

/* ---- firmware error codes (mirror messages.proto ErrCode) ------------------
   protobuf-ts keeps the ERR_ prefix on ErrCode members (unlike Query_What,
   which is prefix-stripped), so read ErrCode.ERR_* and fall back to the literal
   numeric so the mock is robust even if the generated names ever change. */
const ERR = {
  INTERNAL: ErrCode.ERR_INTERNAL ?? 1,
  AUTH_REQUIRED: ErrCode.ERR_AUTH_REQUIRED ?? 401,
  AUTH_EXPIRED: ErrCode.ERR_AUTH_EXPIRED ?? 419,
  NOT_FOUND: ErrCode.ERR_NOT_FOUND ?? 404,
  BAD_REQUEST: ErrCode.ERR_BAD_REQUEST ?? 400,
  UNSUPPORTED: ErrCode.ERR_UNSUPPORTED ?? 501,
};

/* The board's plaintext password the mock validates the HMAC against. Override
   with MOCK_BOARD_PASSWORD; the SIL harness passes the same value to the CLI. */
const BOARD_PASSWORD = process.env.MOCK_BOARD_PASSWORD ?? 'strawberry';

const PORT = Number(process.env.MOCK_BOARD_PORT ?? process.argv[2] ?? 8080);
const HOST = process.env.MOCK_BOARD_HOST ?? '127.0.0.1';
const log = (...a) => { if (process.env.MOCK_BOARD_QUIET !== '1') console.error('[mock-board]', ...a); };

/* ===========================================================================
   pure-JS HMAC-SHA256 (RFC 2104) — identical math to src/auth/hmac.ts, so the
   mock validates the digest the CLI sends from HMAC-SHA256(password, nonce).
   Uses node:crypto's sha256 (the firmware uses mbedtls; the digest is the same).
   =========================================================================== */
function sha256(buf) { return createHash('sha256').update(buf).digest(); }
function hmacSha256(key, message) {
  const BLOCK = 64;
  let k = key;
  if (k.length > BLOCK) k = sha256(k);
  const block = Buffer.alloc(BLOCK);
  k.copy(block);
  const ipad = Buffer.alloc(BLOCK), opad = Buffer.alloc(BLOCK);
  for (let i = 0; i < BLOCK; i++) { ipad[i] = block[i] ^ 0x36; opad[i] = block[i] ^ 0x5c; }
  return sha256(Buffer.concat([opad, sha256(Buffer.concat([ipad, message]))]));
}

/* ===========================================================================
   Server-wide token table — 8 slots, like ws_auth.c. Each token is bound to the
   connection that minted it (B1). on-close revokes that connection's slot.
   =========================================================================== */
const MAX_SLOTS = 8;
/** slotIdx -> { token, connId } | null */
const slots = new Array(MAX_SLOTS).fill(null);

function mintToken(connId) {
  let idx = slots.findIndex((s) => s === null);
  if (idx < 0) return null; // 8-slot exhaustion (the leak the firmware fix plugged)
  const token = randomUUID().replace(/-/g, '') + randomBytes(8).toString('hex');
  slots[idx] = { token, connId };
  return { token, idx };
}
/** Resume only succeeds while the MINTING connection's slot still holds it.
 *  After that connection closed, the slot was revoked -> miss -> 419 (B1). */
function resumeToken(token) {
  const idx = slots.findIndex((s) => s && s.token === token);
  return idx >= 0 ? idx : -1;
}
function revokeConnSlots(connId) {
  for (let i = 0; i < MAX_SLOTS; i++) if (slots[i] && slots[i].connId === connId) slots[i] = null;
}
function revokeSlotByToken(token) {
  const idx = slots.findIndex((s) => s && s.token === token);
  if (idx >= 0) slots[idx] = null;
  return idx >= 0;
}

/* ===========================================================================
   In-memory grow unit table — only ACTIVE units exist, mirroring
   grow_controller.c: apply_unit creates iff cfg.active, else removes.
   =========================================================================== */
/** id -> { id, name, kind, active, userIo: Map<name, desc> } */
const units = new Map();

function growUnitSet(u) {
  const id = u.id;
  if (!id) return { ok: false, code: ERR.BAD_REQUEST, detail: 'missing unit id' };
  if (u.active) {
    const cur = units.get(id);
    units.set(id, {
      id, name: u.name || id, kind: u.kind ?? GrowKind.SUBSTRATE,
      active: true, userIo: cur ? cur.userIo : new Map(),
    });
  } else {
    // active=false => firmware deactivates + GCs NVS; the unit ceases to exist.
    units.delete(id);
  }
  return { ok: true, detail: `unit set: ${id}` };
}
function growUnitRemove(id) {
  units.delete(id);
  return { ok: true, detail: `removed ${id}` };
}
function growUserIoAdd(unitId, desc, scope) {
  if (!unitId) return { ok: false, code: ERR.BAD_REQUEST, detail: 'missing unit id' };
  if (!desc) return { ok: false, code: ERR.BAD_REQUEST, detail: 'missing desc' };
  if (scope && scope !== 0) {
    return { ok: false, code: ERR.UNSUPPORTED, detail: 'board-scope user endpoints not implemented' };
  }
  const u = units.get(unitId);
  // find_unit_by_id miss -> ERR_NOT_FOUND (0x105). This is the documented OPEN
  // finding: an inactive (active=false) unit was never registered, so io-add 404s.
  if (!u) return { ok: false, code: ERR.NOT_FOUND, detail: 'unit not found' };
  u.userIo.set(desc.name, { name: desc.name, role: desc.role ?? 0, dtype: desc.dtype ?? 3, unit: desc.unit ?? '' });
  return { ok: true, detail: `io added: ${unitId}.${desc.name}` };
}
function growUserIoRemove(unitId, name) {
  const u = units.get(unitId);
  if (!u) return { ok: false, code: ERR.NOT_FOUND, detail: 'unit not found' };
  u.userIo.delete(name);
  return { ok: true, detail: `io removed: ${unitId}.${name}` };
}
function growUserIoList(unitId) {
  const u = units.get(unitId);
  // The firmware streams an empty list for a missing unit (foreach no-ops); it
  // does NOT 404 the list request. Match that: return an empty entries list.
  const entries = u ? [...u.userIo.values()] : [];
  return { unitId, entries };
}

/* ===========================================================================
   Canned read-only query states (faithful shapes, plausible values).
   =========================================================================== */
const BOOT_MS = Date.now();
const nowMs = () => Date.now() - BOOT_MS;

const CANNED = {
  capabilities: () => ({ payload: { oneofKind: 'capabilities', capabilities: {
    zigbee: false, modbus: true, displayKind: 'lvgl', sdCard: true,
    flowSensors: true, waterTopSensor: true, analogPin: true,
  } } }),
  wifi: () => ({ payload: { oneofKind: 'wifi', wifi: {
    ssid: 'mock-ssid', connected: true, ip: '127.0.0.1', rssi: -47,
  } } }),
  deviceConfig: () => ({ payload: { oneofKind: 'deviceConfig', deviceConfig: {
    gpio2Mode: 0, pwmMode: 0, ws2812Count: 8, statsPeriodMs: 1000, theme: 'strawberry',
    zbChannel: 25, zbTxPowerDbm: 20, zbInstallPolicy: 0, zbNetworkFormed: false,
    zbShortAddr: 0, zbIeeeAddr: '', zbPermitJoinRemainingS: 0, zbPeerCount: 0,
    zbNlmeErrorsPerMin: 0, zbNlmeErrorsTotal: 0, zbRadioActive: false,
    ctrlRateHz: 0, ctrlHeartbeatMs: 1000, ctrlStaleMs: 0, flow1Ppl: 0, flow2Ppl: 0,
    displayLayout: 0, displayRotation: 0, boardRevOverride: 0, boardRev: 'A2',
    heapGovFloor: 32768, oledBrightness: 0, oledTimeoutS: 0, oledStaMetrics: 0, ws2812Groups: '',
  } } }),
  growConfig: () => ({ payload: { oneofKind: 'growConfig', growConfig: {
    units: [...units.values()].map((u) => ({
      active: u.active, id: u.id, kind: u.kind, name: u.name,
      profileId: 0, stage: 0, manualHold: false, startTsMs: 0n, stageEnteredMs: 0n,
      health: 1, flags: 0, schedParams: [], schedStages: [],
    })),
    profiles: [],
  } } }),
  systemFlags: () => ({ payload: { oneofKind: 'systemFlags', systemFlags: {
    onewireEnabled: true, modbusEnabled: true, zigbeeEnabled: false,
    zigbeeSupported: false, canEnabled: false,
  } } }),
  time: () => ({ payload: { oneofKind: 'timeStatus', timeStatus: {
    synced: true, lastSyncUnixMs: BigInt(Date.now()), nowUnixMs: BigInt(Date.now()),
    timezone: 'UTC', ntpServer: 'pool.ntp.org',
  } } }),
  wgConfig: () => ({ payload: { oneofKind: 'wgConfig', wgConfig: {
    enabled: false, hasPrivateKey: false, peerPublicKey: '', localIp: '',
    localNetmask: '', peerEndpoint: '', peerPort: 0, keepaliveS: 0,
  } } }),
  wgStatus: () => ({ payload: { oneofKind: 'wgStatus', wgStatus: {
    state: 0, enabled: false, configured: false, lastErr: 0, retryCount: 0, stateSinceS: 0,
  } } }),
  ota: () => ({ payload: { oneofKind: 'ota', ota: { inProgress: false, percent: 0, detail: '' } } }),
  owSensors: () => ({ payload: { oneofKind: 'owSensors', owSensors: { sensors: [] } } }),
  owConfig: () => ({ payload: { oneofKind: 'owConfig', owConfig: { boards: [] } } }),
  soil: () => ({ payload: { oneofKind: 'soilProbes', soilProbes: { probes: [] } } }),
  ha: () => ({ payload: { oneofKind: 'haConfig', haConfig: {
    enabled: false, mqttUri: '', mqttUser: '', topicPrefix: 'strawberry', connected: false, lastError: '',
  } } }),
  deviceList: () => ({ payload: { oneofKind: 'deviceList', deviceList: { devices: [] } } }),
  snapshot: () => ({ payload: { oneofKind: 'snapshot', snapshot: {
    bme680Valid: true, airTemp: 23.4, airHumidity: 51.2, pressure: 1013.2, gasResistance: 50000,
    iaqValid: true, iaq: 42, bh1750Valid: true, lux: 320, ds18b20: [], soil: [],
    weightKg: [], hx711Valid: [], vinV: 12.1, iinA: 0.4, inputW: 4.8, hbridgeA: 0, motorW: 0,
    flow1Pps: 0, flow2Pps: 0, hasFlow2: false, moistureMv: 0, hasMoisture: false,
    waterTop: false, vsensPg: true, uptimeMs: BigInt(nowMs()), deviceId: 'mock-board',
    fwVersion: 'mock-1.0.0', datetime: new Date().toISOString(), wifiMode: 'sta',
    wifiSsid: 'mock-ssid', wifiIp: '127.0.0.1', mcpAux: [], boardRev: 'A2',
  } } }),
};

const TOPIC_STATS = 0x04;

function mockStats() {
  return {
    freeHeap: 76000, minFreeHeap: 42000, largestFreeBlock: 60000,
    cpuPercentTotal: 34.8, rssi: -47, uptimeMs: BigInt(nowMs()),
    tasks: [
      { name: 'main', stackHighWm: 2048, cpuPercent: 5.2, priority: 5, stackSize: 8192, cpuPermille: 52 },
      { name: 'IDLE', stackHighWm: 512, cpuPercent: 60.0, priority: 0, stackSize: 1536, cpuPermille: 600 },
      { name: 'tiT', stackHighWm: 1024, cpuPercent: 2.1, priority: 18, stackSize: 4096, cpuPermille: 21 },
    ],
  };
}

/* ===========================================================================
   Frame handling — decode ClientMessage, dispatch, reply with ServerMessage.
   =========================================================================== */
function encodeServer(reqId, payload) {
  // ServerMessage.create() recursively fills proto defaults for every nested
  // message + repeated field, so a canned payload need only set the fields that
  // matter (toBinary itself does NOT default-fill and throws on an undefined
  // repeated/scalar — that is the "Cannot read properties of undefined" trap).
  return ServerMessage.toBinary(ServerMessage.create({ requestId: reqId, payload }));
}
function ackReply(reqId, ok, detail) {
  return encodeServer(reqId, { oneofKind: 'ack', ack: { ok, detail: detail ?? '' } });
}
function errReply(reqId, code, detail) {
  return encodeServer(reqId, { oneofKind: 'error', error: { code, detail } });
}

/** Per-connection mutable state. */
function newConn(id) { return { id, authed: false, nonce: null, statsTimer: null }; }

/** Map a Query.what to a canned reply payload, or null if push-only/unknown. */
function queryReply(what) {
  switch (what) {
    case Query_What.SNAPSHOT: return CANNED.snapshot();        // 1  — real query (fw line 209)
    case Query_What.OW_SENSORS: return CANNED.owSensors();     // 3
    case Query_What.SOIL: return CANNED.soil();                // 4
    case Query_What.WIFI: return CANNED.wifi();                // 5
    case Query_What.HA: return CANNED.ha();                    // 6
    case Query_What.OTA: return CANNED.ota();                  // 7
    case Query_What.DEVICE_LIST: return CANNED.deviceList();   // 8
    case Query_What.DEVICE_CONFIG: return CANNED.deviceConfig(); // 9
    case Query_What.TIME: return CANNED.time();                // 10
    case Query_What.GROW_CONFIG: return CANNED.growConfig();   // 11
    case Query_What.SYSTEM_FLAGS: return CANNED.systemFlags(); // 12
    case Query_What.WIREGUARD: return CANNED.wgConfig();       // 13
    case Query_What.WG_STATUS: return CANNED.wgStatus();       // 14
    case Query_What.CAPABILITIES: return CANNED.capabilities(); // 15
    case Query_What.OW_CONFIG: return CANNED.owConfig();       // 16
    // WHAT_STATS (2) has NO case in ws_dispatch.c -> "unknown query" (B2).
    default: return null;
  }
}

function handleClientFrame(conn, send, frame) {
  const kind = frame[0];

  // 0x01 = raw OTA chunk: 0x01 || uint32-LE offset || bytes. Ack with the next
  // expected offset (rid=0 OtaChunkAck), like the firmware's chunk path.
  if (kind === 0x01) {
    const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
    const offset = view.getUint32(1, true);
    const dataLen = frame.byteLength - 5;
    send(encodeServer(0, { oneofKind: 'otaChunkAck', otaChunkAck: { nextOffset: offset + dataLen } }));
    return;
  }

  if (kind !== 0x00) { log('unknown frame kind', kind); return; }

  let cm;
  try { cm = ClientMessage.fromBinary(frame.subarray(1)); }
  catch (e) { log('decode error', e.message); return; }

  const rid = cm.requestId;
  const p = cm.payload;
  switch (p.oneofKind) {
    /* ---- auth (SEC-001) ---- */
    case 'authChallengeReq': {
      conn.nonce = randomBytes(16);
      send(encodeServer(rid, { oneofKind: 'authChallenge', authChallenge: { nonce: conn.nonce } }));
      return;
    }
    case 'login': {
      if (!conn.nonce) { send(errReply(rid, ERR.AUTH_REQUIRED, 'no challenge')); return; }
      const expect = hmacSha256(Buffer.from(BOARD_PASSWORD, 'utf8'), conn.nonce);
      const got = Buffer.from(p.login.hmac ?? new Uint8Array());
      conn.nonce = null; // single-use
      if (got.length !== expect.length || !timingSafeEq(got, expect)) {
        send(errReply(rid, ERR.AUTH_REQUIRED, 'bad password')); return;
      }
      const minted = mintToken(conn.id);
      if (!minted) { send(errReply(rid, ERR.INTERNAL, 'no auth slot')); return; }
      conn.authed = true;
      send(encodeServer(rid, { oneofKind: 'authOk', authOk: {
        token: minted.token, ttlMs: p.login.desiredTtlMs || 86400000,
        serverNowMs: BigInt(nowMs()),
      } }));
      return;
    }
    case 'authResume': {
      // B1: succeeds only while the minting socket is still open. After it closed
      // the slot was revoked -> miss -> ERR_AUTH_EXPIRED, exactly the firmware.
      const idx = resumeToken(p.authResume.token);
      if (idx < 0) { send(errReply(rid, ERR.AUTH_EXPIRED, 'token expired')); return; }
      // Re-bind the slot to THIS connection so its own close revokes it.
      slots[idx].connId = conn.id;
      conn.authed = true;
      send(encodeServer(rid, { oneofKind: 'authOk', authOk: {
        token: p.authResume.token, ttlMs: 86400000, serverNowMs: BigInt(nowMs()),
      } }));
      return;
    }
    case 'authRevoke': {
      revokeSlotByToken(p.authRevoke.token);
      conn.authed = false;
      send(ackReply(rid, true, 'revoked'));
      return;
    }

    /* ---- subscribe (TOPIC_STATS push loop) ---- */
    case 'subscribe': {
      const topics = p.subscribe.topics >>> 0;
      send(ackReply(rid, true, 'subscribed'));
      if (topics & TOPIC_STATS) {
        if (!conn.statsTimer) {
          // Full Stats immediately (the firmware sends a full frame on subscribe),
          // then a ~10 Hz fast loop — here we just resend full Stats each tick,
          // which the PushBus folds the same way (stats topic).
          send(encodeServer(0, { oneofKind: 'stats', stats: mockStats() }));
          conn.statsTimer = setInterval(() => {
            try { send(encodeServer(0, { oneofKind: 'stats', stats: mockStats() })); }
            catch { /* socket gone */ }
          }, 250);
        }
      } else if (conn.statsTimer) {
        clearInterval(conn.statsTimer); conn.statsTimer = null;
      }
      return;
    }

    /* ---- queries ---- */
    case 'query': {
      const reply = queryReply(p.query.what);
      if (reply) send(encodeServer(rid, reply.payload));
      else send(errReply(rid, ERR.BAD_REQUEST, 'unknown query')); // WHAT_STATS path (B2)
      return;
    }

    /* ---- grow units + user IO (in-memory, models the ERR_NOT_FOUND quirk) ---- */
    case 'growUnitSet': {
      const r = growUnitSet(p.growUnitSet.unit ?? {});
      send(r.ok ? ackReply(rid, true, r.detail) : errReply(rid, r.code, r.detail));
      return;
    }
    case 'growUnitRemove': {
      const r = growUnitRemove(p.growUnitRemove.id);
      send(ackReply(rid, r.ok, r.detail));
      return;
    }
    case 'growUserIoAdd': {
      const m = p.growUserIoAdd;
      const r = growUserIoAdd(m.unitId, m.desc, m.scope);
      send(r.ok ? ackReply(rid, true, r.detail) : errReply(rid, r.code, r.detail));
      return;
    }
    case 'growUserIoRemove': {
      const r = growUserIoRemove(p.growUserIoRemove.unitId, p.growUserIoRemove.name);
      send(r.ok ? ackReply(rid, true, r.detail) : errReply(rid, r.code, r.detail));
      return;
    }
    case 'growUserIoListReq': {
      const list = growUserIoList(p.growUserIoListReq.unitId);
      send(encodeServer(rid, { oneofKind: 'growUserIoList', growUserIoList: list }));
      return;
    }

    /* ---- controllers ---- */
    case 'ctrlListReq': {
      send(encodeServer(rid, { oneofKind: 'ctrlList', ctrlList: { controllers: [] } }));
      return;
    }

    /* ---- system / config writes: ack ---- */
    case 'systemFlagsSet':
    case 'cfgSet':
    case 'wifiSet':
    case 'haSet':
    case 'wgSet':
    case 'ioSet':
    case 'ioPersistSet':
    case 'ioMqttSet':
    case 'ctrlGraphApply':
    case 'ctrlCreate':
    case 'ctrlBind':
    case 'ctrlSetEnabled':
    case 'ctrlSetTarget':
    case 'ctrlSetParams':
    case 'ctrlDestroy':
    case 'growScheduleSet':
    case 'growProfileSet':
    case 'owConfigSet':
      send(ackReply(rid, true, p.oneofKind));
      return;

    /* ---- reboot / OTA lifecycle ---- */
    case 'reboot':
      send(ackReply(rid, true, 'rebooting'));
      return;
    case 'otaUploadBegin':
      send(ackReply(rid, true, 'ota begin'));
      return;
    case 'otaUploadEnd':
      send(ackReply(rid, true, 'ota end'));
      return;
    case 'otaUploadAbort':
      send(ackReply(rid, true, 'ota abort'));
      return;

    default:
      send(errReply(rid, ERR.BAD_REQUEST, `unhandled: ${p.oneofKind}`));
      return;
  }
}

function timingSafeEq(a, b) {
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a[i] ^ b[i];
  return r === 0;
}

/* ===========================================================================
   Minimal RFC6455 WebSocket server over node:http (no `ws` dependency).
   Handles the handshake, a binary-frame decoder (supporting client masking +
   fragmentation), close, ping/pong, and a binary-frame encoder for sends.
   =========================================================================== */
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
let connSeq = 0;

const server = createServer((req, res) => {
  // A bare HTTP GET (health check) — the firmware serves the SPA here; we just 200.
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end('mock-board: ws at /ws\n');
});

server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (!key) { socket.destroy(); return; }
  const accept = createHash('sha1').update(key + WS_GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );

  const conn = newConn(++connSeq);
  log(`conn ${conn.id} open (${req.url})`);

  const send = (bytes) => {
    if (socket.destroyed) return;
    socket.write(encodeFrame(bytes, 0x2)); // 0x2 = binary
  };

  let buf = Buffer.alloc(0);
  const fragments = [];
  socket.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      const parsed = decodeFrame(buf);
      if (!parsed) break;
      buf = parsed.rest;
      const { opcode, payload, fin } = parsed;
      if (opcode === 0x8) { socket.end(); return; }           // close
      if (opcode === 0x9) { socket.write(encodeFrame(payload, 0xA)); continue; } // ping->pong
      if (opcode === 0xA) continue;                            // pong
      if (opcode === 0x0 || opcode === 0x1 || opcode === 0x2) {
        fragments.push(payload);
        if (!fin) continue;
        const full = fragments.length === 1 ? fragments[0] : Buffer.concat(fragments);
        fragments.length = 0;
        if (full.length >= 1) {
          try { handleClientFrame(conn, send, full); }
          catch (e) { log('handler error', e.stack || e.message); }
        }
      }
    }
  });

  const cleanup = () => {
    if (conn.statsTimer) { clearInterval(conn.statsTimer); conn.statsTimer = null; }
    revokeConnSlots(conn.id); // B1: a token is revoked when its socket closes.
    log(`conn ${conn.id} closed`);
  };
  socket.on('close', cleanup);
  socket.on('error', () => { try { socket.destroy(); } catch {} cleanup(); });
});

/** Encode a single (unmasked, server->client) WS frame. */
function encodeFrame(payload, opcode) {
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = 0x80 | (opcode & 0x0f); // FIN + opcode
  return Buffer.concat([header, payload]);
}

/** Decode one frame from `buf`; returns { opcode, payload, fin, rest } or null. */
function decodeFrame(buf) {
  if (buf.length < 2) return null;
  const b0 = buf[0], b1 = buf[1];
  const fin = (b0 & 0x80) !== 0;
  const opcode = b0 & 0x0f;
  const masked = (b1 & 0x80) !== 0;
  let len = b1 & 0x7f;
  let offset = 2;
  if (len === 126) { if (buf.length < 4) return null; len = buf.readUInt16BE(2); offset = 4; }
  else if (len === 127) { if (buf.length < 10) return null; len = Number(buf.readBigUInt64BE(2)); offset = 10; }
  let mask = null;
  if (masked) { if (buf.length < offset + 4) return null; mask = buf.subarray(offset, offset + 4); offset += 4; }
  if (buf.length < offset + len) return null;
  let payload = buf.subarray(offset, offset + len);
  if (masked) {
    const out = Buffer.alloc(len);
    for (let i = 0; i < len; i++) out[i] = payload[i] ^ mask[i & 3];
    payload = out;
  } else {
    payload = Buffer.from(payload);
  }
  return { opcode, payload, fin, rest: buf.subarray(offset + len) };
}

server.listen(PORT, HOST, () => {
  log(`listening on ws://${HOST}:${PORT}/ws (password="${BOARD_PASSWORD}")`);
  // Emit a machine-readable ready line so run-sil.mjs can wait on it.
  console.log(`MOCK_BOARD_READY ws://${HOST}:${PORT}/ws`);
});

/* Graceful shutdown for the SIL harness. */
function shutdown() { try { server.close(); } catch {} process.exit(0); }
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
