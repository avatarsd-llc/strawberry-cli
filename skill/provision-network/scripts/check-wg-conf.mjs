#!/usr/bin/env node
// Validate a wg-quick .conf for `strawberry wg apply` BEFORE sending it to a board.
//
// Pure local parse + netmask derivation — no network. Mirrors the firmware logic
// (wg_client.c) and the device-side fields the CLI's WgSet carries: the on-link
// netmask is derived from the AllowedIPs subnet that CONTAINS the [Interface]
// Address, so the tunnel subnet is on-link via wg while the LAN keeps routing
// over Wi-Fi. Exits non-zero with a clear message on any missing/invalid field.
//
//   node check-wg-conf.mjs <wg-quick.conf>
//
// On success prints the derived line, e.g.:
//   OK  10.8.0.7/255.255.255.0 -> vpn.example.com:51820 keepalive=25s

import { readFileSync } from 'node:fs';

function fail(msg) {
  process.stderr.write(`check-wg-conf: ${msg}\n`);
  process.exit(1);
}

function ipToInt(ip) {
  const parts = String(ip).split('.');
  if (parts.length !== 4) return null;
  let v = 0;
  for (const p of parts) {
    const n = Number(p);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
    v = (v << 8 >>> 0) | n;
  }
  return v >>> 0;
}

function prefixToMask(p) {
  const pl = Math.max(0, Math.min(32, p));
  const m = pl === 0 ? 0 : ((0xffffffff << (32 - pl)) >>> 0);
  return [24, 16, 8, 0].map((sh) => (m >>> sh) & 0xff).join('.');
}

// Longest AllowedIPs prefix whose subnet contains `ip` (matches prefix_for_ip).
function prefixForIp(ip, cidrs) {
  const ipn = ipToInt(ip);
  if (ipn === null) return null;
  let best = null;
  for (const c of cidrs) {
    const [net, plenStr] = c.split('/');
    const netn = ipToInt((net || '').trim());
    if (netn === null || !plenStr) continue;
    const pl = Number(plenStr);
    if (!Number.isInteger(pl) || pl < 0 || pl > 32) continue;
    const mask = pl === 0 ? 0 : ((0xffffffff << (32 - pl)) >>> 0);
    if (((ipn & mask) >>> 0) === ((netn & mask) >>> 0) && (best === null || pl > best)) {
      best = pl;
    }
  }
  return best;
}

function parseConf(text) {
  let section = '';
  let priv = '';
  let pub = '';
  let addr = '';
  let endpoint = '';
  let keep = '';
  let allowed = [];

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.split('#')[0].trim();
    if (!line) continue;
    if (line.startsWith('[')) {
      section = line.toLowerCase();
      continue;
    }
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim().toLowerCase();
    const val = line.slice(eq + 1).trim();
    if (section.includes('interface')) {
      if (key === 'privatekey') priv = val;
      else if (key === 'address') addr = val;
    } else if (section.includes('peer')) {
      if (key === 'publickey') pub = val;
      else if (key === 'endpoint') endpoint = val;
      else if (key === 'persistentkeepalive') keep = val;
      else if (key === 'allowedips') {
        allowed = val.split(',').map((s) => s.trim()).filter(Boolean);
      }
    }
  }

  if (!priv) fail('[Interface] PrivateKey missing');
  if (!pub) fail('[Peer] PublicKey missing');
  if (!endpoint) fail('[Peer] Endpoint missing');
  if (!addr) fail('[Interface] Address missing');

  const first = addr.split(',')[0].trim();
  const ip = first.split('/')[0].trim();
  if (!ip || ipToInt(ip) === null) fail(`[Interface] Address not a valid IPv4: "${first}"`);

  // Derive netmask: prefer the AllowedIPs subnet that contains the Address;
  // fall back to the Address's own /prefix, then /32.
  let prefix = prefixForIp(ip, allowed);
  if (prefix === null) {
    const own = first.includes('/') ? Number(first.split('/')[1]) : NaN;
    if (allowed.length && !Number.isInteger(own)) {
      fail(`[Interface] Address ${ip} is not inside any [Peer] AllowedIPs subnet ` +
           `(${allowed.join(', ') || 'none'}) and has no /prefix — cannot derive on-link netmask`);
    }
    prefix = Number.isInteger(own) ? own : 32;
  }

  // Endpoint host:port (rpartition on ':' to tolerate bare host).
  const lastColon = endpoint.lastIndexOf(':');
  let host = endpoint;
  let port = '';
  if (lastColon > 0) {
    host = endpoint.slice(0, lastColon);
    port = endpoint.slice(lastColon + 1);
  }
  const peerPort = port ? Number(port) : 51820;
  if (!Number.isInteger(peerPort) || peerPort < 1 || peerPort > 65535) {
    fail(`[Peer] Endpoint port invalid: "${port}"`);
  }
  const keepalive = keep ? Number(keep) : 0;
  if (!Number.isInteger(keepalive) || keepalive < 0) fail(`PersistentKeepalive invalid: "${keep}"`);

  return {
    local_ip: ip,
    local_netmask: prefixToMask(prefix),
    peer_endpoint: host,
    peer_port: peerPort,
    keepalive_s: keepalive,
  };
}

const path = process.argv[2];
if (!path) fail('usage: node check-wg-conf.mjs <wg-quick.conf>');

let text;
try {
  text = readFileSync(path, 'utf8');
} catch (e) {
  fail(`cannot read ${path}: ${e.message}`);
}

const c = parseConf(text);
process.stdout.write(
  `OK  ${c.local_ip}/${c.local_netmask} -> ${c.peer_endpoint}:${c.peer_port} ` +
  `keepalive=${c.keepalive_s}s\n`,
);
