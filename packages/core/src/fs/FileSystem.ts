/**
 * The seam between the pure core and the host editor.
 *
 * Only IO lives here; path manipulation is pure and lives in `./paths`. The core
 * has two implementations: `MemoryFileSystem` (tests) and `VscodeFileSystem`
 * (the client, over `vscode.workspace.fs`). A future LSP server would add a
 * `node:fs` implementation — no core change required.
 *
 * All paths are absolute, forward-slash POSIX strings.
 */

export enum FileType {
  File = 'file',
  Directory = 'directory',
  SymbolicLink = 'symlink',
  Unknown = 'unknown',
}

export interface DirEntry {
  name: string;
  type: FileType;
}

export interface FileSystem {
  /** Read a UTF-8 file. Rejects if it does not exist. */
  readFile(path: string): Promise<string>;
  /** List immediate children. Rejects if the directory does not exist. */
  readDirectory(path: string): Promise<DirEntry[]>;
  /** Stat a path, or `null` if it does not exist (never rejects for absence). */
  stat(path: string): Promise<{ type: FileType } | null>;
  exists(path: string): Promise<boolean>;
}
