import { paths, pathsOutsideRoots, type TextEditOp, touchedPaths, type WorkspaceEdit } from 'devkit-for-strapi-core';
import { mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

interface Position {
  line: number;
  character: number;
}

function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
  return starts;
}

/**
 * Apply text edits to one file's content (right-to-left so offsets don't shift).
 * Drops exact duplicates and **refuses overlapping ranges** (throws): applying
 * overlapping edits would silently corrupt the file. A hard safety boundary
 * independent of whichever planner — or hand-built `plan` — produced the edits.
 */
function applyTextEdits(content: string, edits: TextEditOp[]): string {
  const starts = lineStarts(content);
  const offset = (p: Position): number => (starts[p.line] ?? content.length) + p.character;
  const ranges = edits.map((e) => ({ from: offset(e.start), to: offset(e.end), newText: e.newText }));
  const seen = new Set<string>();
  const unique = ranges.filter((r) => {
    const key = `${r.from}:${r.to}:${r.newText}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const ascending = [...unique].sort((a, b) => a.from - b.from || a.to - b.to);
  for (let i = 1; i < ascending.length; i++) {
    if (ascending[i]!.from < ascending[i - 1]!.to) {
      throw new Error(`Overlapping text edits at offset ${ascending[i]!.from} — refusing to apply (would corrupt the file).`);
    }
  }
  let out = content;
  for (const r of [...unique].sort((a, b) => b.from - a.from)) out = out.slice(0, r.from) + r.newText + out.slice(r.to);
  return out;
}

export interface ApplyResult {
  filesChanged: string[];
  filesCreated: string[];
  filesRenamed: { from: string; to: string }[];
  filesDeleted: string[];
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/** Realpath of the nearest *existing* ancestor of `p` (POSIX-normalized). */
async function realParent(p: string): Promise<string> {
  let dir = paths.dirname(p);
  for (;;) {
    try {
      return paths.normalize(await realpath(dir));
    } catch {
      const up = paths.dirname(dir);
      if (up === dir) return paths.normalize(dir);
      dir = up;
    }
  }
}

/**
 * The real path a write would land on: if `p` exists, `realpath` resolves it —
 * including a **leaf symlink** (which `writeFile` would follow) — so a symlinked
 * file in the repo can't redirect a write outside the root. If `p` doesn't exist
 * yet (create / rename target), only its parent can be a symlink.
 */
async function realTarget(p: string): Promise<string> {
  try {
    return paths.normalize(await realpath(p));
  } catch {
    return paths.join(await realParent(p), paths.basename(p));
  }
}

/**
 * Refuse — atomically, before any mutation — a plan that would touch a path outside
 * the project root(s). Two layers: a literal containment check ({@link pathsOutsideRoots})
 * and a realpath pass that resolves the nearest existing ancestor of every target so a
 * symlink inside the project cannot redirect a write/delete outside the root.
 */
async function assertContained(edit: WorkspaceEdit, allowedRoots: readonly string[]): Promise<void> {
  const outside = pathsOutsideRoots(allowedRoots, edit);
  if (outside.length) {
    throw new Error(`Refusing: ${outside.length} path(s) outside the project root(s): ${outside.join(', ')}`);
  }
  const realRoots: string[] = [];
  for (const r of allowedRoots) {
    try {
      realRoots.push(paths.normalize(await realpath(r)));
    } catch {
      realRoots.push(paths.normalize(r));
    }
  }
  for (const p of touchedPaths(edit)) {
    const rp = await realTarget(p);
    if (!realRoots.some((r) => paths.isPathInside(r, rp))) {
      throw new Error(`Refusing: \`${p}\` resolves outside the project root(s) (symlink escape).`);
    }
  }
}

/**
 * Write a computed {@link WorkspaceEdit} to disk, in dependency order: text edits
 * → file creates → renames → deletes. ALL validation (root containment, overlap,
 * create/rename collision) runs BEFORE any write, so an unsafe plan refuses
 * atomically with nothing written. The core never writes (the `FileSystem` seam is
 * read-only) — applying is the client's job, here over `node:fs`. `allowedRoots`
 * are the discovered project roots; every touched path must stay inside one.
 */
export async function applyWorkspaceEdit(edit: WorkspaceEdit, allowedRoots: readonly string[]): Promise<ApplyResult> {
  // 1. Containment (literal + symlink-resolved) — refuse the whole plan atomically.
  await assertContained(edit, allowedRoots);

  // 2. Precompute + validate text edits (overlap guard throws before any write).
  const byFile = new Map<string, TextEditOp[]>();
  for (const e of edit.textEdits) {
    const arr = byFile.get(e.filePath) ?? [];
    arr.push(e);
    byFile.set(e.filePath, arr);
  }
  const pending: { file: string; original: string; content: string }[] = [];
  for (const [file, edits] of byFile) {
    const content = await readFile(file, 'utf8');
    const updated = applyTextEdits(content, edits);
    if (updated !== content) pending.push({ file, original: content, content: updated });
  }

  // 3. Collision checks — never silently overwrite a create target or rename destination.
  for (const c of edit.fileCreates ?? []) {
    if (await pathExists(c.path)) throw new Error(`Refusing: create target already exists: ${c.path}`);
  }
  for (const r of edit.fileRenames) {
    if (await pathExists(r.to)) throw new Error(`Refusing: rename destination already exists: ${r.to}`);
  }

  // 4. Mutate — best-effort transactional: record an undo for each applied op so that a
  // failure mid-sequence (EPERM/ENOSPC on the Nth rename, …) rolls back in reverse instead
  // of leaving a half-applied tree. Order: text → create → rename → delete (delete last, as
  // a recursive dir delete is the only non-restorable op, after all reversible ones).
  const filesChanged: string[] = [];
  const filesCreated: string[] = [];
  const filesDeleted: string[] = [];
  const undo: Array<() => Promise<void>> = [];
  try {
    for (const { file, original, content } of pending) {
      await writeFile(file, content, 'utf8');
      undo.push(() => writeFile(file, original, 'utf8'));
      filesChanged.push(file);
    }
    for (const c of edit.fileCreates ?? []) {
      await mkdir(dirname(c.path), { recursive: true });
      await writeFile(c.path, c.content, { encoding: 'utf8', flag: 'wx' }); // wx: fail if it appeared (race)
      undo.push(() => rm(c.path, { force: true }));
      filesCreated.push(c.path);
    }
    for (const r of edit.fileRenames) {
      await mkdir(dirname(r.to), { recursive: true });
      await rename(r.from, r.to);
      undo.push(() => rename(r.to, r.from));
    }
    for (const d of edit.fileDeletes ?? []) {
      const st = await stat(d).catch(() => null);
      if (st?.isFile()) {
        const content = await readFile(d, 'utf8'); // snapshot so a file delete is reversible
        await rm(d, { force: true });
        undo.push(() => writeFile(d, content, 'utf8'));
      } else {
        await rm(d, { recursive: true, force: true }); // dir/absent → not snapshot-restorable (runs last)
      }
      filesDeleted.push(d);
    }
  } catch (err) {
    const failed: string[] = [];
    const applied = undo.length;
    for (const u of [...undo].reverse()) {
      try {
        await u();
      } catch (e) {
        failed.push(e instanceof Error ? e.message : String(e));
      }
    }
    const base = err instanceof Error ? err.message : String(err);
    throw new Error(
      failed.length
        ? `Apply failed (${base}); rolled back ${applied - failed.length}/${applied} ops, ${failed.length} could NOT be undone — check the working tree / git.`
        : `Apply failed (${base}); rolled back cleanly — the working tree is unchanged.`,
    );
  }

  return { filesChanged, filesCreated, filesRenamed: edit.fileRenames, filesDeleted };
}

/** @deprecated Use {@link applyWorkspaceEdit}. Kept for existing rename call-sites. */
export const applyRename = applyWorkspaceEdit;
