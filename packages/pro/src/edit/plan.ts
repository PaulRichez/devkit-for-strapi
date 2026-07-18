/**
 * Make a {@link WorkspaceEdit} *contractual*: fingerprint the files it touches so
 * a later apply can refuse if the disk moved since the plan was reviewed (a TOCTOU
 * guard). Only *reads* (via the `FileSystem` seam) and *compares* — the actual
 * write stays the client's job. Reusable by the MCP server and a future LSP. The
 * pure containment helpers (`touchedPaths`/`pathsOutsideRoots`) stay in the core.
 */

import { paths } from 'devkit-for-strapi-core';
import type { FileSystem, WorkspaceEdit } from 'devkit-for-strapi-core';

const { normalize } = paths;

/** Marker hash for a path that does not exist on disk (e.g. a create target). */
export const ABSENT = 'absent';

export interface FileFingerprint {
  path: string;
  /** A content hash, or {@link ABSENT} when the file is expected not to exist. */
  hash: string;
}

/** A {@link WorkspaceEdit} plus the disk state it was computed against. */
export interface PlannedEdit extends WorkspaceEdit {
  /** Hash of the plan + fingerprints — stable id to apply exactly this plan. */
  planId: string;
  fingerprints: FileFingerprint[];
}

/** Fast, non-cryptographic string hash (djb2) — for change detection only. */
export function hashString(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 33) + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/** Files whose *current* content the plan depends on (text edits, renames-from, deletes). */
function existingPaths(edit: WorkspaceEdit): string[] {
  const set = new Set<string>();
  for (const t of edit.textEdits) set.add(normalize(t.filePath));
  for (const r of edit.fileRenames) set.add(normalize(r.from));
  for (const d of edit.fileDeletes ?? []) set.add(normalize(d));
  return [...set];
}

/** Paths the plan expects to be *absent* (create targets + rename destinations). */
function absentPaths(edit: WorkspaceEdit): string[] {
  const set = new Set<string>();
  for (const c of edit.fileCreates ?? []) set.add(normalize(c.path));
  // A rename destination must not already exist — fingerprint it ABSENT so a
  // collision (silent overwrite) is caught at verify time, even on an honest plan.
  for (const r of edit.fileRenames) set.add(normalize(r.to));
  return [...set];
}

async function readOrAbsent(fs: FileSystem, path: string): Promise<string> {
  try {
    return await fs.readFile(path);
  } catch {
    return ABSENT;
  }
}

/** Fingerprint every file the plan reads or expects absent (sorted for a stable planId). */
export async function fingerprintEdit(fs: FileSystem, edit: WorkspaceEdit): Promise<FileFingerprint[]> {
  const out: FileFingerprint[] = [];
  for (const path of existingPaths(edit)) {
    const content = await readOrAbsent(fs, path);
    out.push({ path, hash: content === ABSENT ? ABSENT : hashString(content) });
  }
  for (const path of absentPaths(edit)) {
    const content = await readOrAbsent(fs, path);
    out.push({ path, hash: content === ABSENT ? ABSENT : hashString(content) });
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/** A {@link WorkspaceEdit} → a {@link PlannedEdit} with fingerprints + a stable planId. */
export async function planEdit(fs: FileSystem, edit: WorkspaceEdit): Promise<PlannedEdit> {
  const fingerprints = await fingerprintEdit(fs, edit);
  const base: WorkspaceEdit = {
    textEdits: edit.textEdits,
    fileRenames: edit.fileRenames,
    fileCreates: edit.fileCreates ?? [],
    fileDeletes: edit.fileDeletes ?? [],
  };
  const planId = hashString(JSON.stringify(base) + '|' + JSON.stringify(fingerprints));
  return { ...base, planId, fingerprints };
}

export interface VerifyResult {
  ok: boolean;
  /** Paths whose on-disk content no longer matches the fingerprint. */
  changed: string[];
}

/**
 * Re-read the fingerprinted files and report any that changed since the plan was
 * computed. A non-empty `changed` means *do not apply* — the plan is stale.
 */
export async function verifyFingerprints(fs: FileSystem, fingerprints: FileFingerprint[]): Promise<VerifyResult> {
  const changed: string[] = [];
  for (const fp of fingerprints) {
    const content = await readOrAbsent(fs, fp.path);
    const now = content === ABSENT ? ABSENT : hashString(content);
    if (now !== fp.hash) changed.push(fp.path);
  }
  return { ok: changed.length === 0, changed };
}
