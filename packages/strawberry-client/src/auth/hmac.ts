/**
 * SEC-001 client-side auth primitive.
 *
 * The plaintext password never crosses the WS wire: the browser derives
 * HMAC-SHA256(password, nonce) locally and sends only the 32-byte digest, which
 * the firmware recomputes from its NVS password + the single-use nonce it
 * handed out (mbedtls, ws_hmac.c) and constant-time compares.
 *
 * SECURE-CONTEXT TRAP (the SEC-001 regression): the device serves this SPA over
 * plain http://<LAN-IP> (TLS is too heavy for the 4 MB board), and `crypto.subtle`
 * (Web Crypto) is ONLY defined in a *secure context* (https or localhost). In a
 * real browser over http, `crypto.subtle` is `undefined`, so the previous
 * importKey/sign implementation threw "Cannot read properties of undefined" and
 * login was completely broken. Node's vitest runtime DOES expose a global
 * crypto.subtle, which is exactly why the host unit test passed while the
 * browser failed. The fix is a self-contained pure-JS HMAC-SHA256 that runs in
 * ANY context with no secure-context dependency; it is the path taken over http.
 *
 * Factored out of WsService as a pure function so it can be pinned by a host
 * unit test against the SHARED JS<->C test vector without standing up the
 * Angular DI graph (the service constructor needs NgZone + localStorage).
 */

/* ---- pure-JS SHA-256 ----------------------------------------------------- */

/* FIPS 180-4 round constants (first 32 bits of the fractional parts of the cube
   roots of the first 64 primes). */
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const rotr = (x: number, n: number): number => (x >>> n) | (x << (32 - n));

/** SHA-256 of an arbitrary byte string. Returns the 32-byte digest. */
function sha256(msg: Uint8Array): Uint8Array {
  /* Initial hash state: fractional parts of the square roots of the first 8 primes. */
  let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
  let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;

  const bitLen = msg.length * 8;
  /* Pad to a multiple of 64 bytes: 0x80, then zeros, then the 64-bit big-endian
     length. We only need the low 32 length bits in practice (password+nonce are
     short), but write the full 64-bit field per the spec. */
  const padLen = ((msg.length + 8) >> 6 << 6) + 64;
  const buf = new Uint8Array(padLen);
  buf.set(msg);
  buf[msg.length] = 0x80;
  /* Big-endian 64-bit bit length in the final 8 bytes. */
  const hi = Math.floor(bitLen / 0x100000000);
  const lo = bitLen >>> 0;
  buf[padLen - 8] = (hi >>> 24) & 0xff;
  buf[padLen - 7] = (hi >>> 16) & 0xff;
  buf[padLen - 6] = (hi >>> 8) & 0xff;
  buf[padLen - 5] = hi & 0xff;
  buf[padLen - 4] = (lo >>> 24) & 0xff;
  buf[padLen - 3] = (lo >>> 16) & 0xff;
  buf[padLen - 2] = (lo >>> 8) & 0xff;
  buf[padLen - 1] = lo & 0xff;

  const w = new Uint32Array(64);

  for (let off = 0; off < padLen; off += 64) {
    for (let i = 0; i < 16; i++) {
      const j = off + i * 4;
      w[i] = (buf[j] << 24) | (buf[j + 1] << 16) | (buf[j + 2] << 8) | buf[j + 3];
    }
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }

    let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;

    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K[i] + w[i]) | 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0;
      d = c; c = b; b = a; a = (t1 + t2) | 0;
    }

    h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0;
    h4 = (h4 + e) | 0; h5 = (h5 + f) | 0; h6 = (h6 + g) | 0; h7 = (h7 + h) | 0;
  }

  const out = new Uint8Array(32);
  const words = [h0, h1, h2, h3, h4, h5, h6, h7];
  for (let i = 0; i < 8; i++) {
    out[i * 4] = (words[i] >>> 24) & 0xff;
    out[i * 4 + 1] = (words[i] >>> 16) & 0xff;
    out[i * 4 + 2] = (words[i] >>> 8) & 0xff;
    out[i * 4 + 3] = words[i] & 0xff;
  }
  return out;
}

const SHA256_BLOCK = 64;

/** HMAC-SHA256(key, message) per RFC 2104. Pure JS, no Web Crypto. */
function hmacSha256(key: Uint8Array, message: Uint8Array): Uint8Array {
  /* Keys longer than the block size are hashed down; shorter keys are
     zero-padded to the block size. */
  let k = key;
  if (k.length > SHA256_BLOCK) k = sha256(k);
  const block = new Uint8Array(SHA256_BLOCK);
  block.set(k);

  const ipad = new Uint8Array(SHA256_BLOCK);
  const opad = new Uint8Array(SHA256_BLOCK);
  for (let i = 0; i < SHA256_BLOCK; i++) {
    ipad[i] = block[i] ^ 0x36;
    opad[i] = block[i] ^ 0x5c;
  }

  const inner = sha256(concat(ipad, message));
  return sha256(concat(opad, inner));
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/* ---- public API ---------------------------------------------------------- */

/**
 * HMAC-SHA256(password, nonce).  The password is the HMAC key (its UTF-8 bytes);
 * the nonce is the message.  Resolves to the 32-byte digest.
 *
 * Implemented with a self-contained pure-JS HMAC-SHA256 so it works in ANY
 * browsing context — crucially over plain http, where `crypto.subtle` is
 * `undefined` (non-secure context). The async signature is kept so callers in
 * ws.service.ts need no change. We deliberately do NOT route through
 * crypto.subtle even when it is available: the device is always served over
 * http, so the pure-JS path is the one that must run, and keeping a single path
 * means the host unit test pins exactly what the browser executes.
 */
export async function hmacSha256Password(password: string, nonce: Uint8Array): Promise<Uint8Array> {
  const keyBytes = new TextEncoder().encode(password);
  return hmacSha256(keyBytes, nonce);
}
