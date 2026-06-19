/**
 * TokenStore seam (ADR-0066) — replaces ws.service.ts's bare localStorage calls
 * (the STORAGE_TOKEN_KEY logic at :39,:149,:486,:506,:555). DeviceClient persists
 * the SEC-001 session token through this interface so the same client works in a
 * browser (LocalStorageTokenStore), in tests/Pulumi (MemoryTokenStore), and on a
 * 0600 file (FileTokenStore, ./node).
 */

export interface TokenStore {
  get(): string | null;
  set(token: string): void;
  clear(): void;
}

export const STORAGE_TOKEN_KEY = 'strawberry.token';

/** In-memory token (default; lost on process exit). */
export class MemoryTokenStore implements TokenStore {
  private token: string | null;
  constructor(initial: string | null = null) { this.token = initial; }
  get(): string | null { return this.token; }
  set(token: string): void { this.token = token; }
  clear(): void { this.token = null; }
}

/** Structural subset of the Web Storage API (avoids requiring the DOM lib). */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** Browser token persistence backed by localStorage (or any StorageLike). */
export class LocalStorageTokenStore implements TokenStore {
  private readonly storage: StorageLike;
  private readonly key: string;
  constructor(storage?: StorageLike, key: string = STORAGE_TOKEN_KEY) {
    const s = storage ?? (globalThis as { localStorage?: StorageLike }).localStorage;
    if (!s) throw new Error('LocalStorageTokenStore: no localStorage available; pass a StorageLike');
    this.storage = s;
    this.key = key;
  }
  get(): string | null { return this.storage.getItem(this.key); }
  set(token: string): void { this.storage.setItem(this.key, token); }
  clear(): void { this.storage.removeItem(this.key); }
}
