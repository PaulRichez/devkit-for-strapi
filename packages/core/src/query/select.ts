/**
 * Pick the Strapi project a ref-keyed query applies to, in a multi-project
 * workspace (a monorepo with several Strapi apps). Mirrors how the editor
 * disambiguates by the cursor's file — here the agent passes a path (`from`,
 * the file it is editing) or a project name. *Garantir, ne pas deviner*: when it
 * stays ambiguous, return the candidates rather than silently picking one.
 */

import { basename, isPathInside, normalize } from '../fs/paths';
import type { StrapiProject, StrapiVersion } from '../model/types';

export interface ProjectCandidate {
  name: string;
  root: string;
  version: StrapiVersion;
}

export type ProjectSelection = { project: StrapiProject } | { ambiguous: true; candidates: ProjectCandidate[] };

export interface ProjectSelector {
  /** A path inside the target project (typically the file the agent is editing). */
  from?: string;
  /** A project name (the basename of its root) or its root path. */
  project?: string;
}

const candidate = (p: StrapiProject): ProjectCandidate => ({
  name: basename(p.root),
  root: p.root,
  version: p.version,
});

/**
 * Resolve a selector against the discovered projects (expected sorted
 * longest-root-first, as the engine keeps them, so the deepest owner wins).
 */
export function selectProject(projects: StrapiProject[], selector: ProjectSelector = {}): ProjectSelection {
  if (projects.length === 0) return { ambiguous: true, candidates: [] };

  if (selector.from) {
    const f = normalize(selector.from);
    const owner = projects.find((p) => isPathInside(p.root, f));
    if (owner) return { project: owner };
  }

  if (selector.project) {
    const want = normalize(selector.project).toLowerCase();
    const matches = projects.filter(
      (p) => basename(p.root).toLowerCase() === want || normalize(p.root).toLowerCase() === want,
    );
    if (matches.length === 1) return { project: matches[0]! };
    if (matches.length > 1) return { ambiguous: true, candidates: matches.map(candidate) };
  }

  // An explicit selector (`from`/`project`) that matched nothing must NOT fall
  // through to the lone-project shortcut: the caller expressed an intent and it
  // was unsatisfiable, so return the real candidates rather than confidently
  // handing back an unrelated project (garantir, ne pas deviner). The shortcut
  // is only for the *no-selector* case (one project, nothing asked → use it).
  if (selector.from || selector.project) return { ambiguous: true, candidates: projects.map(candidate) };

  if (projects.length === 1) return { project: projects[0]! };
  return { ambiguous: true, candidates: projects.map(candidate) };
}
