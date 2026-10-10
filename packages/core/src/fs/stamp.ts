import type { FileSystem } from './FileSystem';

/** Concurrent stats while fingerprinting (a plugin set is a few hundred files). */
const STAT_CONCURRENCY = 32;

/**
 * A cheap fingerprint of a set of paths: each one's type and mtime (`-` when
 * absent), in the given order. Stats only, no reads — equal stamps mean nothing
 * listed was created, deleted or rewritten (a folder's mtime moves when an entry
 * is added or removed).
 */
export async function pathsStamp(fs: FileSystem, paths: readonly string[]): Promise<string> {
  const parts = new Array<string>(paths.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < paths.length) {
      const i = next++;
      const st = await fs.stat(paths[i]!);
      parts[i] = st ? `${st.type}:${st.mtime ?? 'x'}` : '-';
    }
  };
  await Promise.all(Array.from({ length: Math.min(STAT_CONCURRENCY, paths.length) }, worker));
  return parts.join('|');
}
