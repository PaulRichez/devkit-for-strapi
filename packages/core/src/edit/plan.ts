/**
 * Containment helpers for a {@link WorkspaceEdit} — the safety primitives the
 * executor needs *before* it writes. Pure (literal): the core only enumerates the
 * paths an edit would touch and checks they stay inside the allowed root(s). The
 * fingerprint/plan/verify machinery (the contractual TOCTOU guard) lives in the
 * Pro package; these two helpers stay here because the free MCP executor
 * (`apply.ts`) imports them to refuse an out-of-root plan.
 */

import { isAbsolute, isPathInside, normalize } from '../fs/paths';
import type { WorkspaceEdit } from '../model/types';

/** Every path the edit would write/create/rename/delete (for containment checks). */
export function touchedPaths(edit: WorkspaceEdit): string[] {
  const set = new Set<string>();
  for (const t of edit.textEdits) set.add(normalize(t.filePath));
  for (const c of edit.fileCreates ?? []) set.add(normalize(c.path));
  for (const r of edit.fileRenames) {
    set.add(normalize(r.from));
    set.add(normalize(r.to));
  }
  for (const d of edit.fileDeletes ?? []) set.add(normalize(d));
  return [...set];
}

/**
 * Paths the edit would touch that lie **outside every allowed root** (or aren't
 * absolute) — the containment guard for the executor. A non-empty result means
 * *refuse the whole plan*: the apply must never write/rename/delete outside the
 * discovered project root(s). Pure (literal); the client adds a realpath pass for
 * symlink escapes. *Garantir, ne pas deviner* — empty `roots` ⇒ everything is outside.
 */
export function pathsOutsideRoots(roots: readonly string[], edit: WorkspaceEdit): string[] {
  const norm = roots.map(normalize);
  return touchedPaths(edit).filter((p) => !isAbsolute(p) || !norm.some((r) => isPathInside(r, p)));
}
