import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * Persist the project roots discovered via `add_project` so they survive server
 * respawns (a rebuild, a new session) — otherwise the server falls back to cwd /
 * client roots each start and a manually-added project is lost, forcing a
 * re-`add_project` every time. Best-effort, user-level, prunes dead entries.
 */
/** Cache location — overridable via `DEVKIT_ROOTS_CACHE` (tests, custom homes). */
function cacheFile(): string {
  return process.env.DEVKIT_ROOTS_CACHE || join(homedir(), '.devkit-for-strapi', 'roots.json');
}

/** Cached roots that still exist on disk (stale entries are dropped). */
export function loadRootsCache(): string[] {
  try {
    const data: unknown = JSON.parse(readFileSync(cacheFile(), 'utf8'));
    const roots = (data as { roots?: unknown })?.roots;
    if (!Array.isArray(roots)) return [];
    return roots.filter((r): r is string => typeof r === 'string' && existsSync(r));
  } catch {
    return [];
  }
}

/** Merge `roots` into the cache (deduped, existing only). Best-effort. */
export function saveRootsCache(roots: string[]): void {
  try {
    const file = cacheFile();
    const merged = [...new Set([...loadRootsCache(), ...roots])].filter((r) => existsSync(r));
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ roots: merged }, null, 2));
  } catch {
    // best-effort: a read-only home or race is not worth failing a tool call over
  }
}
