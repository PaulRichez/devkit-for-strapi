import { type DirEntry, FileType, type FileSystem } from './FileSystem';
import { dirname, normalize } from './paths';

/**
 * In-memory file system built from a flat `{ path: content }` map. Used by tests
 * (fixtures are loaded from disk into this) and any headless host.
 */
export class MemoryFileSystem implements FileSystem {
  private readonly files = new Map<string, string>();
  private readonly dirs = new Set<string>();

  constructor(files: Record<string, string> = {}) {
    for (const [rawPath, content] of Object.entries(files)) {
      this.writeFile(rawPath, content);
    }
  }

  /** Add or replace a file (also registers ancestor directories). */
  writeFile(rawPath: string, content: string): void {
    const p = normalize(rawPath);
    this.files.set(p, content);
    let d = dirname(p);
    while (d && d !== '.' && !this.dirs.has(d)) {
      this.dirs.add(d);
      const parent = dirname(d);
      if (parent === d) break;
      d = parent;
    }
  }

  delete(rawPath: string): void {
    this.files.delete(normalize(rawPath));
  }

  async readFile(path: string): Promise<string> {
    const p = normalize(path);
    const content = this.files.get(p);
    if (content === undefined) throw new Error(`ENOENT: ${p}`);
    return content;
  }

  async readDirectory(path: string): Promise<DirEntry[]> {
    const dir = normalize(path);
    if (!this.dirs.has(dir) && dir !== '/' && !this.hasAnyUnder(dir)) {
      throw new Error(`ENOTDIR: ${dir}`);
    }
    const prefix = dir === '/' ? '/' : dir + '/';
    const entries = new Map<string, FileType>();
    for (const f of this.files.keys()) {
      if (!f.startsWith(prefix)) continue;
      const rest = f.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash < 0) entries.set(rest, FileType.File);
      else entries.set(rest.slice(0, slash), FileType.Directory);
    }
    for (const d of this.dirs) {
      if (!d.startsWith(prefix)) continue;
      const rest = d.slice(prefix.length);
      const slash = rest.indexOf('/');
      const name = slash < 0 ? rest : rest.slice(0, slash);
      if (name) entries.set(name, FileType.Directory);
    }
    return [...entries].map(([name, type]) => ({ name, type }));
  }

  async stat(path: string): Promise<{ type: FileType } | null> {
    const p = normalize(path);
    if (this.files.has(p)) return { type: FileType.File };
    if (this.dirs.has(p) || this.hasAnyUnder(p)) return { type: FileType.Directory };
    return null;
  }

  async exists(path: string): Promise<boolean> {
    return (await this.stat(path)) !== null;
  }

  private hasAnyUnder(dir: string): boolean {
    const prefix = dir.endsWith('/') ? dir : dir + '/';
    for (const f of this.files.keys()) if (f.startsWith(prefix)) return true;
    return false;
  }
}
