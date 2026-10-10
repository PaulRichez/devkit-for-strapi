/**
 * A cheap picture of a project's own files (path → mtime), for clients without a
 * file watcher (the MCP server): comparing two pictures yields the files created,
 * edited or deleted on disk in between, which the engine then re-indexes
 * incrementally. Stats only, no reads.
 */

import { type FileSystem, FileType } from '../fs/FileSystem';
import { join } from '../fs/paths';

/** Folders that never hold code the index reads. */
const IGNORED = new Set(['node_modules', '.git', '.cache', 'build', '.strapi', '.tmp', 'public', 'coverage', '.next', '.turbo']);
const WATCHED_FILE = /\.(m|c)?(j|t)sx?$|\.json$/;
/** Past this many files the picture is not taken (the client must `refresh` itself). */
export const SNAPSHOT_MAX_FILES = 20_000;
const STAT_CONCURRENCY = 32;

export interface SourceSnapshot {
  files: Map<string, number>;
  /** The folders it covers. */
  dirs: string[];
  /** Too many files: changes on disk are not detected. */
  truncated: boolean;
  takenAt: number;
}

/** The files of `dirs` (recursively) plus `extraFiles`, with their mtimes. */
export async function takeSourceSnapshot(fs: FileSystem, dirs: readonly string[], extraFiles: readonly string[]): Promise<SourceSnapshot> {
  const paths: string[] = [...extraFiles];
  let truncated = false;
  const walk = async (d: string): Promise<void> => {
    let entries;
    try {
      entries = await fs.readDirectory(d);
    } catch {
      return;
    }
    for (const e of entries) {
      if (truncated) return;
      if (e.type === FileType.Directory) {
        if (!IGNORED.has(e.name)) await walk(join(d, e.name));
      } else if (WATCHED_FILE.test(e.name) && !e.name.endsWith('.d.ts')) {
        if (paths.length >= SNAPSHOT_MAX_FILES) truncated = true;
        else paths.push(join(d, e.name));
      }
    }
  };
  for (const d of dirs) await walk(d);
  const files = new Map<string, number>();
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < paths.length) {
      const p = paths[next++]!;
      const st = await fs.stat(p);
      if (st?.type === FileType.File) files.set(p, st.mtime ?? 0);
    }
  };
  await Promise.all(Array.from({ length: Math.min(STAT_CONCURRENCY, paths.length) }, worker));
  return { files, dirs: [...dirs], truncated, takenAt: Date.now() };
}

/** `snapshot` extended with folders it doesn't cover yet (their files as they are now). */
export async function extendSnapshot(fs: FileSystem, snapshot: SourceSnapshot, dirs: readonly string[]): Promise<SourceSnapshot> {
  const missing = dirs.filter((d) => !snapshot.dirs.includes(d));
  if (!missing.length) return snapshot;
  const more = await takeSourceSnapshot(fs, missing, []);
  const files = new Map(snapshot.files);
  for (const [p, m] of more.files) if (!files.has(p)) files.set(p, m);
  return { files, dirs: [...snapshot.dirs, ...missing], truncated: snapshot.truncated || more.truncated || files.size > SNAPSHOT_MAX_FILES, takenAt: snapshot.takenAt };
}

/** What changed from `before` to `after`. */
export function diffSnapshots(before: SourceSnapshot, after: SourceSnapshot): { changed: string[]; deleted: string[] } {
  const changed: string[] = [];
  const deleted: string[] = [];
  for (const [p, m] of after.files) if (before.files.get(p) !== m) changed.push(p);
  for (const p of before.files.keys()) if (!after.files.has(p)) deleted.push(p);
  return { changed, deleted };
}
