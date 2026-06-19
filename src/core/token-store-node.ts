/**
 * FileTokenStore (the `./node` subpath) — 0600 token persistence for the CLI and
 * the Pulumi provider, so a session survives across process runs and the reboots
 * that OTA / system-flags changes cause.
 *
 * The token file is created/written with mode 0600 (owner read/write only): the
 * SEC-001 session token is a bearer credential.
 */
import { readFileSync, writeFileSync, rmSync, chmodSync, existsSync } from 'node:fs';
import type { TokenStore } from './token-store.js';

export class FileTokenStore implements TokenStore {
  private readonly path: string;
  private cached: string | null = null;
  private loaded = false;

  constructor(path: string) { this.path = path; }

  get(): string | null {
    if (this.loaded) return this.cached;
    this.loaded = true;
    try {
      if (!existsSync(this.path)) { this.cached = null; return null; }
      const raw = readFileSync(this.path, 'utf8').trim();
      this.cached = raw.length ? raw : null;
    } catch {
      this.cached = null;
    }
    return this.cached;
  }

  set(token: string): void {
    this.cached = token;
    this.loaded = true;
    // mode on the open() only applies when the file is created; chmod after the
    // write guarantees 0600 even if the file pre-existed with looser perms.
    writeFileSync(this.path, token, { mode: 0o600 });
    try { chmodSync(this.path, 0o600); } catch { /* best effort */ }
  }

  clear(): void {
    this.cached = null;
    this.loaded = true;
    try { rmSync(this.path, { force: true }); } catch { /* already gone */ }
  }
}
