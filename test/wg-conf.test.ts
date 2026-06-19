import { describe, it, expect } from 'vitest';
import { parseWgConf } from '../src/cli/wg-conf.js';

const CONF = `
[Interface]
PrivateKey = aGVsbG8td29ybGQtcHJpdmF0ZS1rZXktYmFzZTY0LXBhZA=
Address = 10.7.0.5/32

[Peer]
PublicKey = cGVlci1wdWJsaWMta2V5LWJhc2U2NC1wYWRkaW5nLXh4eA=
Endpoint = vpn.example.com:51820
AllowedIPs = 10.7.0.0/24, 0.0.0.0/0
PersistentKeepalive = 25
`;

describe('parseWgConf', () => {
  it('parses interface + peer and derives the on-link netmask from AllowedIPs', () => {
    const c = parseWgConf(CONF);
    expect(c.localIp).toBe('10.7.0.5');
    // 10.7.0.0/24 contains the address, so the netmask is /24.
    expect(c.localNetmask).toBe('255.255.255.0');
    expect(c.peerEndpoint).toBe('vpn.example.com');
    expect(c.peerPort).toBe(51820);
    expect(c.keepaliveS).toBe(25);
    expect(c.privateKey).toContain('aGVsbG8');
    expect(c.enabled).toBe(true);
  });

  it('falls back to the Address /prefix when no AllowedIPs subnet contains it', () => {
    // AllowedIPs is a foreign subnet, so prefixForIp returns null and the parser
    // falls back to the Interface Address's own /30.
    const c = parseWgConf(`
[Interface]
Address = 192.168.9.2/30
[Peer]
PublicKey = x
Endpoint = 1.2.3.4:1234
AllowedIPs = 172.16.0.0/24
`);
    expect(c.localNetmask).toBe('255.255.255.252');
    expect(c.peerPort).toBe(1234);
  });

  it('a 0.0.0.0/0 full-tunnel AllowedIPs yields a /0 netmask (route-all, matches wg-quick)', () => {
    const c = parseWgConf(`
[Interface]
Address = 10.9.0.2/32
[Peer]
PublicKey = x
Endpoint = 1.2.3.4:1234
AllowedIPs = 0.0.0.0/0
`);
    expect(c.localNetmask).toBe('0.0.0.0');
  });

  it('throws on a conf with no Interface Address', () => {
    expect(() => parseWgConf('[Peer]\nPublicKey = x\n')).toThrow(/no \[Interface\] Address/);
  });
});
