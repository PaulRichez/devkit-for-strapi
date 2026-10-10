import { promises as fsp } from 'node:fs';
import { type DirEntry, type FileSystem, FileType } from '../../src/fs/FileSystem';

/** A real-disk FileSystem for opt-in e2e tests (the core itself never imports node:fs). */
export class NodeFileSystem implements FileSystem {
  async readFile(path: string): Promise<string> {
    return fsp.readFile(path, 'utf8');
  }
  async readDirectory(path: string): Promise<DirEntry[]> {
    const entries = await fsp.readdir(path, { withFileTypes: true });
    return entries.map((e) => ({
      name: e.name,
      type: e.isDirectory() ? FileType.Directory : e.isFile() ? FileType.File : e.isSymbolicLink() ? FileType.SymbolicLink : FileType.Unknown,
    }));
  }
  async stat(path: string): Promise<{ type: FileType; mtime?: number } | null> {
    try {
      const s = await fsp.stat(path);
      return { type: s.isDirectory() ? FileType.Directory : s.isFile() ? FileType.File : FileType.Unknown, mtime: s.mtimeMs };
    } catch {
      return null;
    }
  }
  async exists(path: string): Promise<boolean> {
    return (await this.stat(path)) !== null;
  }
  async realpath(path: string): Promise<string> {
    return (await fsp.realpath(path)).replace(/\\/g, '/');
  }
}
