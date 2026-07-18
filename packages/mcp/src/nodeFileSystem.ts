import type { Dirent, Stats } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { type DirEntry, FileType, type FileSystem } from 'devkit-for-strapi-core';

function statType(s: Stats): FileType {
  if (s.isDirectory()) return FileType.Directory;
  if (s.isFile()) return FileType.File;
  if (s.isSymbolicLink()) return FileType.SymbolicLink;
  return FileType.Unknown;
}

/**
 * A directory entry's kind WITHOUT following symlinks: a symlinked entry is reported
 * as `SymbolicLink`, not its target. The recursive walks (discovery / indexer /
 * reference / move) only recurse into `Directory` entries, so symlinked directories
 * are skipped — closing a symlink-loop DoS at the source. (`stat()` below still
 * resolves, for explicit existence checks.)
 */
function entryType(entry: Dirent): FileType {
  if (entry.isSymbolicLink()) return FileType.SymbolicLink;
  if (entry.isDirectory()) return FileType.Directory;
  if (entry.isFile()) return FileType.File;
  return FileType.Unknown;
}

/**
 * `FileSystem` implementation backed by `node:fs` — the seam impl for the MCP
 * server (and any future LSP/CLI). The core stays pure (it never imports
 * `node:fs`); this lives in the server package, mirroring `VscodeFileSystem`.
 * Paths are absolute forward-slash POSIX; `node:fs` accepts them on every OS.
 */
export class NodeFileSystem implements FileSystem {
  async readFile(path: string): Promise<string> {
    return readFile(path, 'utf8');
  }

  async readDirectory(path: string): Promise<DirEntry[]> {
    const entries = await readdir(path, { withFileTypes: true });
    return entries.map((e) => ({ name: e.name, type: entryType(e) }));
  }

  async stat(path: string): Promise<{ type: FileType } | null> {
    try {
      return { type: statType(await stat(path)) };
    } catch {
      return null;
    }
  }

  async exists(path: string): Promise<boolean> {
    return (await this.stat(path)) !== null;
  }
}
