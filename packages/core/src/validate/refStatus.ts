/**
 * The one verdict on a Strapi reference: does a fully-qualified ref exist, as a
 * given kind, in this project — `valid`, `unknown`, or `external` (DevKit can't
 * tell: a plugin it can't read, a framework built-in, a registry it couldn't see
 * whole). The editor diagnostics (`validator.ts`), `validate_reference` and
 * `list_broken_refs` (`query/refQuery.ts`) all decide existence here, so a ref
 * one of them accepts is never reported by another.
 *
 * Callers resolve first (a bare plugin name qualified by `strapi.plugin('a')`, a
 * short route handler by its file): this takes the qualified ref.
 */

import { hasContentType, hasPartialContentTypes } from '../index/codeContentTypes';
import { normalizeApiName } from '../index/loaderNames';
import type { ArtifactKind, StrapiProject } from '../model/types';
import { isFrameworkRef, parseComponentUid, parseEntityRef } from '../model/uid';
import { isOpenCollection, isVerifiablePlugin } from '../plugins/merge';

export type RefStatus = 'valid' | 'unknown' | 'external';

/**
 * What a ref is checked as. `method` checks the **entity** a route handler or a
 * member call goes through (a controller, a service, or a content-type's
 * generated controller) — never the action, which a spread or a runtime
 * extension can add.
 */
export type StatusKind = 'content-type' | 'component' | ArtifactKind | 'method';

/** The artifact kinds a ref of `kind` can be registered as (for the open-registry check). */
function artifactKindsOf(kind: StatusKind): ArtifactKind[] {
  if (kind === 'method') return ['controller', 'service'];
  if (kind === 'content-type' || kind === 'component') return [];
  return [kind];
}

/** Is `ref` registered as `kind` in the project's index? */
function exists(project: StrapiProject, kind: StatusKind, ref: string): boolean {
  const idx = project.index;
  switch (kind) {
    case 'component':
      return idx.components.has(ref);
    case 'content-type':
      // A bare `<category>.<name>` is a component, which the DB-layer APIs accept too.
      return ref.includes('::') ? hasContentType(idx, ref) : idx.components.has(ref);
    // Strapi generates the core service/controller of every content-type.
    case 'service':
      return idx.services.has(ref) || hasContentType(idx, ref);
    case 'controller':
      return idx.controllers.has(ref) || hasContentType(idx, ref);
    case 'method':
      return idx.controllers.has(ref) || idx.services.has(ref) || hasContentType(idx, ref);
    case 'policy':
      return idx.policies.has(ref);
    case 'middleware':
      return idx.middlewares.has(ref);
  }
}

/**
 * True when a ref DevKit doesn't find can't be called unknown: a framework
 * built-in, a plugin it can't verify, a local plugin whose content-types or
 * registry it couldn't read whole.
 */
export function isUnverifiable(project: StrapiProject, kind: StatusKind, ref: string): boolean {
  if (isFrameworkRef(ref)) return !(kind === 'middleware' && ref.startsWith('strapi::') && project.index.frameworkMiddlewares);
  const parsed = parseEntityRef(ref);
  if (!parsed || parsed.namespace !== 'plugin') return false;
  const idx = project.index;
  if (!isVerifiablePlugin(idx, parsed.scope)) return true;
  if (kind !== 'policy' && kind !== 'middleware' && hasPartialContentTypes(idx, parsed.scope)) return true;
  return artifactKindsOf(kind).some((k) => isOpenCollection(idx, parsed.scope, k));
}

/** The verdict on a fully-qualified `ref` checked as `kind` (see the module doc). */
export function refStatus(project: StrapiProject, kind: StatusKind, ref: string): RefStatus {
  if (kind === 'middleware' && ref.startsWith('strapi::') && project.index.frameworkMiddlewares) {
    return project.index.frameworkMiddlewares.has(ref) ? 'valid' : 'unknown';
  }
  if (exists(project, kind, ref)) return 'valid';
  if (isUnverifiable(project, kind, ref)) return 'external';
  return 'unknown';
}

/**
 * The name Strapi registers for an API ref written with its raw folder or file
 * name (`api::foo.hasAccess` → `api::foo.has-access`, see `loaderNames.ts`),
 * when that name is one of `keys` — the exact suggestion, ahead of any edit
 * distance (which would otherwise point back at the raw name, or nowhere).
 */
export function loaderNameOf(ref: string, keys: { has(key: string): boolean }): string | undefined {
  const parsed = parseEntityRef(ref);
  if (!parsed || parsed.namespace !== 'api') return undefined;
  const registered = `api::${normalizeApiName(parsed.scope)}.${normalizeApiName(parsed.name)}`;
  return registered !== ref && keys.has(registered) ? registered : undefined;
}

/** True when `ref` has the shape of a component UID (`<category>.<name>`). */
export function isComponentShaped(ref: string): boolean {
  return !ref.includes('::') && parseComponentUid(ref) !== null;
}
