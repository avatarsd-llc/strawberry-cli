import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { hmacSha256Password } from '../src/auth/hmac.js';

const hex = (b: Uint8Array) => Array.from(b).map((x) => x.toString(16).padStart(2, '0')).join('');

/** Independent reference (Node's OpenSSL-backed HMAC) — a different implementation
 *  than the pure-JS one under test, so agreement is a real cross-check. */
const ref = (pw: string, nonce: Uint8Array) =>
  new Uint8Array(createHmac('sha256', Buffer.from(pw, 'utf8')).update(Buffer.from(nonce)).digest());

describe('hmacSha256Password — SEC-001 client auth (re-homed from SPA)', () => {
  it('matches the SHARED firmware<->JS<->Python test vector (ws_hmac.c / ota_check.py)', async () => {
    // HMAC-SHA256(key="strawberry", msg = bytes 0x00..0x0f) — the cross-impl pin the
    // device login depends on; if this drifts, login breaks against the firmware.
    const nonce = new Uint8Array(Array.from({ length: 16 }, (_, i) => i));
    expect(hex(await hmacSha256Password('strawberry', nonce)))
      .toBe('880e5c19ec51b5646794e768dd50f6ec6f7961b9de89dd79852d00d7482bfaed');
  });

  it('matches RFC 4231 Test Case 2 (key "Jefe")', async () => {
    const data = new TextEncoder().encode('what do ya want for nothing?');
    expect(hex(await hmacSha256Password('Jefe', data)))
      .toBe('5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843');
  });

  it('agrees with Node crypto across the key-hash + padding branches', async () => {
    const cases: Array<[string, Uint8Array]> = [
      ['p', new Uint8Array([1, 2, 3])],
      ['strawberry', new Uint8Array(0)],
      ['strawberry', new Uint8Array(Array.from({ length: 64 }, (_, i) => i & 0xff))],
      ['x'.repeat(100), new Uint8Array([9, 9, 9])],
      ['pâté🔑', new Uint8Array([0xff, 0x00, 0x80])],
    ];
    for (const [pw, nonce] of cases) {
      expect(hex(await hmacSha256Password(pw, nonce)), `pw=${JSON.stringify(pw)} n=${nonce.length}`)
        .toBe(hex(ref(pw, nonce)));
    }
  });

  it('returns a 32-byte digest', async () => {
    const d = await hmacSha256Password('strawberry', new Uint8Array([1]));
    expect(d).toBeInstanceOf(Uint8Array);
    expect(d.length).toBe(32);
  });
});
