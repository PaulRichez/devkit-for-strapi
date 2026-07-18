import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/** Absolute path to the fixtures directory. */
export const FIXTURES_DIR = resolve(here, '..', 'fixtures');

function toPosix(p: string): string {
  const s = p.replace(/\\/g, '/');
  // Match the engine's canonical form (`paths.normalize` lowercases the Windows
  // drive letter) so path-equality assertions in tests compare like for like.
  return /^[A-Z]:(\/|$)/.test(s) ? s[0]!.toLowerCase() + s.slice(1) : s;
}

export interface LoadedFixture {
  /** Forward-slash absolute path to the fixture root. */
  root: string;
  /** Map of forward-slash absolute path → file content. */
  files: Record<string, string>;
}

export function fixturePath(name: string): string {
  return toPosix(resolve(FIXTURES_DIR, name));
}

/** Recursively read a fixture project tree into a flat `{ path: content }` map. */
export function loadFixture(name: string): LoadedFixture {
  const root = resolve(FIXTURES_DIR, name);
  const files: Record<string, string> = {};

  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else files[toPosix(full)] = readFileSync(full, 'utf8');
    }
  };
  walk(root);

  return { root: toPosix(root), files };
}
