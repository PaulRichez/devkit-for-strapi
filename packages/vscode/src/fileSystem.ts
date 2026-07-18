import {
  type DirEntry,
  FileType as CoreFileType,
  type FileSystem,
} from 'devkit-for-strapi-core';
import * as vscode from 'vscode';

const decoder = new TextDecoder('utf-8');

function toUri(path: string): vscode.Uri {
  return vscode.Uri.file(path);
}

function mapType(t: vscode.FileType): CoreFileType {
  // FileType is a bitmask; symlinks carry File/Directory too. Resolve the real
  // kind first so symlinked source files are indexed (not skipped as symlinks).
  if (t & vscode.FileType.Directory) return CoreFileType.Directory;
  if (t & vscode.FileType.File) return CoreFileType.File;
  if (t & vscode.FileType.SymbolicLink) return CoreFileType.SymbolicLink;
  return CoreFileType.Unknown;
}

/** `FileSystem` implementation backed by `vscode.workspace.fs`. */
export class VscodeFileSystem implements FileSystem {
  async readFile(path: string): Promise<string> {
    const bytes = await vscode.workspace.fs.readFile(toUri(path));
    return decoder.decode(bytes);
  }

  async readDirectory(path: string): Promise<DirEntry[]> {
    const entries = await vscode.workspace.fs.readDirectory(toUri(path));
    return entries.map(([name, type]) => ({ name, type: mapType(type) }));
  }

  async stat(path: string): Promise<{ type: CoreFileType } | null> {
    try {
      const s = await vscode.workspace.fs.stat(toUri(path));
      return { type: mapType(s.type) };
    } catch {
      return null;
    }
  }

  async exists(path: string): Promise<boolean> {
    return (await this.stat(path)) !== null;
  }
}
