import { describe, it, expect } from 'vitest';
import { parseArgs, flagStr, flagBool, flagNum, flagList } from '../src/cli/args.js';

const BOOL = new Set(['json', 'active', 'no-onewire', 'zigbee']);

describe('parseArgs', () => {
  it('separates positionals from valued flags', () => {
    const p = parseArgs(['query', 'stats', '--host', '10.0.0.1', '--json'], BOOL);
    expect(p.positionals).toEqual(['query', 'stats']);
    expect(flagStr(p, 'host')).toBe('10.0.0.1');
    expect(flagBool(p, 'json')).toBe(true);
  });

  it('supports --flag=value', () => {
    const p = parseArgs(['ota', 'upload', '--bin=/tmp/app.bin'], BOOL);
    expect(flagStr(p, 'bin')).toBe('/tmp/app.bin');
  });

  it('treats a declared boolean as a switch even before a value-looking token', () => {
    // --no-onewire is a declared switch; the next token stays positional/other.
    const p = parseArgs(['system', 'flags', '--no-onewire', '--host', 'h'], BOOL);
    expect(flagBool(p, 'no-onewire')).toBe(true);
    expect(flagStr(p, 'host')).toBe('h');
  });

  it('reads numbers and missing numbers', () => {
    const p = parseArgs(['system', 'config', '--ws2812-count', '12'], BOOL);
    expect(flagNum(p, 'ws2812-count')).toBe(12);
    expect(flagNum(p, 'absent')).toBeUndefined();
  });

  it('collects repeated and comma-separated list flags', () => {
    const p = parseArgs(['record', '--topics', 'stats,io', '--topics', 'log'], BOOL);
    expect(flagList(p, 'topics').sort()).toEqual(['io', 'log', 'stats']);
  });

  it('a bare valued flag at the end becomes a boolean true (no value to grab)', () => {
    const p = parseArgs(['auth', 'login', '--host'], BOOL);
    // host has no value; flagStr returns undefined (it is a bare switch here).
    expect(flagStr(p, 'host')).toBeUndefined();
  });
});
