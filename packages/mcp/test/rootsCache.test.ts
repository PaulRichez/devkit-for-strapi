import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadRootsCache, saveRootsCache } from '../src/rootsCache';

describe('roots cache (add_project persistence)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'devkit-cache-'));
    process.env.DEVKIT_ROOTS_CACHE = join(dir, 'roots.json');
  });
  afterEach(() => {
    delete process.env.DEVKIT_ROOTS_CACHE;
    rmSync(dir, { recursive: true, force: true });
  });

  it('round-trips existing roots and merges (deduped)', () => {
    expect(loadRootsCache()).toEqual([]);
    saveRootsCache([dir]); // dir exists on disk
    expect(loadRootsCache()).toEqual([dir]);
    saveRootsCache([dir]); // idempotent merge
    expect(loadRootsCache()).toEqual([dir]);
  });

  it('prunes entries that no longer exist on disk', () => {
    saveRootsCache([dir, join(dir, 'gone-forever')]);
    // only the real directory survives load (and a re-save)
    expect(loadRootsCache()).toEqual([dir]);
  });

  it('never throws on a corrupt/missing cache (best-effort)', () => {
    process.env.DEVKIT_ROOTS_CACHE = join(dir, 'nested', 'does-not-exist.json');
    expect(loadRootsCache()).toEqual([]);
    expect(() => saveRootsCache([dir])).not.toThrow();
  });
});
