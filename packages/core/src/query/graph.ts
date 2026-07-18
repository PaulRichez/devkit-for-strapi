/**
 * Treat the reference index as a queryable *graph*: list a plugin/api's surface
 * by glob, and walk dependencies (what a ref uses) / dependents (what uses a ref)
 * in either direction, optionally transitively. Pure over one `StrapiProject` —
 * the cut-analysis backbone for modularization ("if I move {set}, which edges
 * become cross-namespace?"). Reuses the existing target-keyed reference index.
 */

import { normalize } from '../fs/paths';
import type { ArtifactKind, StrapiProject } from '../model/types';
import { parseRef } from '../model/uid';
import { definitionsInFile } from '../reference/references';
import { referencesOf, type TargetKind } from './refQuery';

export interface RefSummary {
  ref: string;
  /** Every kind this ref resolves to (a UID can be a content-type *and* a service). */
  kinds: TargetKind[];
}

const ARTIFACT_KINDS: ArtifactKind[] = ['service', 'controller', 'policy', 'middleware'];

/** All entity refs known in the project (content-types, artifacts, components). */
function allRefs(project: StrapiProject): Map<string, Set<TargetKind>> {
  const out = new Map<string, Set<TargetKind>>();
  const add = (ref: string, kind: TargetKind): void => {
    const s = out.get(ref) ?? new Set<TargetKind>();
    s.add(kind);
    out.set(ref, s);
  };
  for (const uid of project.index.contentTypes.keys()) add(uid, 'content-type');
  for (const uid of project.index.components.keys()) add(uid, 'component');
  const maps = {
    service: project.index.services,
    controller: project.index.controllers,
    policy: project.index.policies,
    middleware: project.index.middlewares,
  };
  for (const k of ARTIFACT_KINDS) for (const ref of maps[k].keys()) add(ref, k);
  return out;
}

/**
 * Match a glob where only `*` is special (matches any run, incl. `.`/`:`). Linear
 * (no backtracking) — fixed prefix/suffix + in-order middle literals — so a hostile
 * pattern like `a*a*a*…` can't trigger catastrophic RegExp backtracking (ReDoS).
 */
function globMatch(pattern: string, s: string): boolean {
  const parts = pattern.split('*');
  if (parts.length === 1) return s === pattern; // no wildcard → exact
  const first = parts[0]!;
  const last = parts[parts.length - 1]!;
  if (!s.startsWith(first) || !s.endsWith(last)) return false;
  let idx = first.length;
  const end = s.length - last.length;
  if (idx > end) return false; // prefix and suffix overlap
  for (let i = 1; i < parts.length - 1; i++) {
    const part = parts[i]!;
    const found = s.indexOf(part, idx);
    if (found < 0 || found + part.length > end) return false;
    idx = found + part.length;
  }
  return true;
}

/** Entity refs matching a glob like `plugin::billing.*`, `api::*`, or `*`. */
export function listRefs(project: StrapiProject, pattern: string): RefSummary[] {
  const out: RefSummary[] = [];
  for (const [ref, kinds] of allRefs(project)) {
    if (globMatch(pattern, ref)) out.push({ ref, kinds: [...kinds] });
  }
  return out.sort((a, b) => a.ref.localeCompare(b.ref));
}

/** Definition file(s) that "own" a ref (where its outgoing references live). */
function filesOfEntity(project: StrapiProject, ref: string): Set<string> {
  // Index paths are already POSIX-normalized at build time (join/normalize), as are
  // reference `filePath`s — so no re-normalize here or in the hot loop below.
  const files = new Set<string>();
  const idx = project.index;
  const ct = idx.contentTypes.get(ref);
  if (ct) files.add(ct.schemaPath);
  for (const m of [idx.services, idx.controllers, idx.policies, idx.middlewares]) {
    const a = m.get(ref);
    if (a) files.add(a.filePath);
  }
  const c = idx.components.get(ref);
  if (c) files.add(c.jsonPath);
  return files;
}

/** A reference key (`ct:uid`, `service:ref`, `method:uid.action`, …) → its entity ref. */
function keyToRef(key: string): string {
  const colon = key.indexOf(':');
  if (colon < 0) return key;
  const prefix = key.slice(0, colon);
  const rest = key.slice(colon + 1);
  if (prefix === 'method' || prefix === 'relation-field') {
    // Both are `<uid>.<segment>` (action / field) — strip the trailing segment so a
    // relation-field usage doesn't inject a phantom `api::x.y.field` non-entity ref.
    const p = parseRef(rest);
    return p ? `${p.namespace}::${p.scope}.${p.name}` : rest;
  }
  return rest; // ct/component/service/controller/policy/middleware/plugin
}

/** Entity refs that own `filePath` (the inverse of {@link filesOfEntity}). */
function entitiesOwning(project: StrapiProject, filePath: string): string[] {
  return definitionsInFile(project, filePath).map((d) => keyToRef(d.key));
}

export interface GraphOptions {
  /** Walk the relation transitively (default: only direct edges). */
  transitive?: boolean;
}

/** Refs that `ref` uses — outgoing edges (relations, service/controller calls, …). */
export function dependencies(project: StrapiProject, ref: string, opts?: GraphOptions): string[] {
  const result = new Set<string>();
  const seen = new Set<string>([ref]);
  const queue = [ref];
  while (queue.length) {
    const cur = queue.shift()!;
    const files = filesOfEntity(project, cur);
    if (!files.size) continue;
    for (const [key, locs] of project.references) {
      if (!locs.some((l) => files.has(l.filePath))) continue;
      const target = keyToRef(key);
      if (target === cur) continue;
      result.add(target);
      if (opts?.transitive && !seen.has(target)) {
        seen.add(target);
        queue.push(target);
      }
    }
  }
  result.delete(ref);
  return [...result].sort();
}

/** Refs that use `ref` — incoming edges (who would break if `ref` moved/changed). */
export function dependents(project: StrapiProject, ref: string, opts?: GraphOptions): string[] {
  const result = new Set<string>();
  const seen = new Set<string>([ref]);
  const queue = [ref];
  while (queue.length) {
    const cur = queue.shift()!;
    const files = new Set(referencesOf(project, cur).map((l) => normalize(l.filePath)));
    for (const file of files) {
      for (const owner of entitiesOwning(project, file)) {
        if (owner === cur) continue;
        result.add(owner);
        if (opts?.transitive && !seen.has(owner)) {
          seen.add(owner);
          queue.push(owner);
        }
      }
    }
  }
  result.delete(ref);
  return [...result].sort();
}
