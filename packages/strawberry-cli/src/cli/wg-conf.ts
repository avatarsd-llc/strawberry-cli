/**
 * Parse a wg-quick `.conf` into the fields WgSet (tag 74) needs.
 *
 * Ported 1:1 from tools/wg_provision.py: read [Interface] PrivateKey/Address and
 * [Peer] PublicKey/Endpoint/AllowedIPs/PersistentKeepalive, then derive the
 * device netif netmask from the AllowedIPs subnet that contains the Interface
 * Address (so the tunnel subnet is on-link via wg). Falls back to the Address's
 * own /prefix, then /32.
 */

export interface WgConfParsed {
  enabled: boolean;
  privateKey: string;
  peerPublicKey: string;
  localIp: string;
  localNetmask: string;
  peerEndpoint: string;
  peerPort: number;
  keepaliveS: number;
}

function ipToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let v = 0;
  for (const p of parts) {
    const n = Number(p);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
    v = ((v << 8) | n) >>> 0;
  }
  return v;
}

function prefixToMask(prefix: number): string {
  const p = Math.max(0, Math.min(32, prefix));
  const m = p === 0 ? 0 : (0xffffffff << (32 - p)) >>> 0;
  return [24, 16, 8, 0].map((sh) => (m >>> sh) & 0xff).join('.');
}

/** Longest matching AllowedIPs prefix that contains `ip`, or null. */
function prefixForIp(ip: string, cidrs: string[]): number | null {
  const ipn = ipToInt(ip);
  if (ipn === null) return null;
  let best: number | null = null;
  for (const c of cidrs) {
    const [net, plenStr] = c.split('/');
    const netn = ipToInt((net ?? '').trim());
    if (netn === null || !plenStr) continue;
    const pl = Number(plenStr);
    const mask = pl === 0 ? 0 : (0xffffffff << (32 - pl)) >>> 0;
    if (((ipn & mask) >>> 0) === ((netn & mask) >>> 0) && (best === null || pl > best)) {
      best = pl;
    }
  }
  return best;
}

export function parseWgConf(text: string): WgConfParsed {
  let section = '';
  let priv = '';
  let pub = '';
  let addr = '';
  let endpoint = '';
  let keep = '';
  let allowed: string[] = [];

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.split('#', 1)[0].trim();
    if (!line) continue;
    if (line.startsWith('[')) { section = line.toLowerCase(); continue; }
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
      else if (key === 'allowedips') allowed = val.split(',').map((s) => s.trim()).filter(Boolean);
    }
  }

  const first = (addr.split(',')[0] ?? '').trim();
  const ip = (first.split('/')[0] ?? '').trim();
  if (!ip) throw new Error('wg conf: no [Interface] Address');

  let prefix = prefixForIp(ip, allowed);
  if (prefix === null) {
    const own = first.split('/')[1];
    prefix = own ? Number(own) : 32;
  }

  // Endpoint host:port — rpartition on ':' so IPv6 literals don't truncate.
  const lastColon = endpoint.lastIndexOf(':');
  const host = lastColon >= 0 ? endpoint.slice(0, lastColon) : endpoint;
  const port = lastColon >= 0 ? endpoint.slice(lastColon + 1) : '';

  return {
    enabled: true,
    privateKey: priv,
    peerPublicKey: pub,
    localIp: ip,
    localNetmask: prefixToMask(prefix),
    peerEndpoint: host,
    peerPort: port ? Number(port) : 51820,
    keepaliveS: keep ? Number(keep) : 0,
  };
}
