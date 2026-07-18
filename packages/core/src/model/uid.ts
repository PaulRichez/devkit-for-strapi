/** Build and parse Strapi reference strings (UIDs and code refs). */

import type { ArtifactKind, ArtifactScope } from './types';

export interface ParsedRef {
  namespace: 'api' | 'plugin' | 'global';
  /** API name or plugin name; '' for global. */
  scope: string;
  name: string;
  /** Trailing action segment, e.g. the `find` in `api::blog.article.find`. */
  action?: string;
}

export function buildContentTypeUid(apiName: string, ctName: string): string {
  return `api::${apiName}.${ctName}`;
}

export function buildPluginContentTypeUid(pluginName: string, ctName: string): string {
  return `plugin::${pluginName}.${ctName}`;
}

export function buildComponentUid(category: string, name: string): string {
  return `${category}.${name}`;
}

export function buildArtifactRef(
  scope: ArtifactScope,
  name: string,
  owner?: { apiName?: string; pluginName?: string },
): string {
  if (scope === 'global') return `global::${name}`;
  if (scope === 'plugin') return `plugin::${owner?.pluginName ?? ''}.${name}`;
  return `api::${owner?.apiName ?? ''}.${name}`;
}

/**
 * Framework-owned namespaces (`admin::user`, `strapi::core-store`,
 * `admin::isAuthenticatedAdmin`, …). These are real, queryable UIDs / built-in
 * policies registered by Strapi core, but they live **outside** the workspace
 * (in `node_modules`) so we can't verify them — like an external plugin, they
 * must never be flagged. *Garantir, ne pas deviner.*
 */
const FRAMEWORK_NAMESPACES: ReadonlySet<string> = new Set(['admin', 'strapi']);

/** True for a `admin::*` / `strapi::*` reference (framework built-in, unverifiable). */
export function isFrameworkRef(text: string): boolean {
  const sep = text.indexOf('::');
  return sep > 0 && FRAMEWORK_NAMESPACES.has(text.slice(0, sep));
}

export interface ParsedHandler {
  /** The controller ref (`api::x.y`, possibly nested `api::x.y.z`). */
  controllerRef: string;
  /** The action segment (always the last dot-segment). */
  action: string;
  parsed: Omit<ParsedRef, 'action'>;
}

/**
 * Parse a route handler (`api::foo.bar.find`, or nested `api::foo.a.b.find`) into
 * its controller ref + action. The action is always the **last** dot-segment;
 * everything before it is the controller ref (which may itself be a nested,
 * dotted name). Uses {@link parseEntityRef} so a nested controller name isn't
 * misread as name + action — the misparse that corrupted quickfixes/rewrites.
 */
export function parseHandlerRef(handler: string): ParsedHandler | null {
  const lastDot = handler.lastIndexOf('.');
  if (lastDot <= 0) return null;
  const controllerRef = handler.slice(0, lastDot);
  const action = handler.slice(lastDot + 1);
  if (!action) return null;
  const parsed = parseEntityRef(controllerRef);
  if (!parsed || parsed.namespace === 'global') return null;
  return { controllerRef, action, parsed };
}

/** Parse `api::x.y[.z]`, `plugin::x.y[.z]`, or `global::name`. */
export function parseRef(ref: string): ParsedRef | null {
  const sep = ref.indexOf('::');
  if (sep < 0) return null;
  const ns = ref.slice(0, sep);
  const rest = ref.slice(sep + 2);
  if (!rest) return null;

  if (ns === 'global') {
    if (rest.includes('.')) return null;
    return { namespace: 'global', scope: '', name: rest };
  }
  if (ns === 'api' || ns === 'plugin') {
    const parts = rest.split('.');
    if (parts.length < 2 || parts.some((p) => p.length === 0)) return null;
    const scope = parts[0]!;
    const name = parts[1]!;
    const action = parts[2];
    return action ? { namespace: ns, scope, name, action } : { namespace: ns, scope, name };
  }
  return null;
}

/**
 * Parse an entity ref (content-type / service / controller — never an action
 * segment): `api::x.y`, `plugin::x.y`, or a **nested** artifact name like
 * `plugin::x.y.z` (`services/y/z.js` → name `y.z`), or `global::name`.
 * Unlike {@link parseRef}, everything after the first dot is the name — so a
 * dotted (nested) artifact name is never mistaken for `name` + trailing
 * `action` (that misparse flagged a real nested service as "Malformed").
 */
export function parseEntityRef(ref: string): Omit<ParsedRef, 'action'> | null {
  const sep = ref.indexOf('::');
  if (sep < 0) return null;
  const ns = ref.slice(0, sep);
  const rest = ref.slice(sep + 2);
  if (!rest) return null;

  if (ns === 'global') {
    if (rest.includes('.')) return null;
    return { namespace: 'global', scope: '', name: rest };
  }
  if (ns === 'api' || ns === 'plugin') {
    const dot = rest.indexOf('.');
    if (dot <= 0 || dot === rest.length - 1) return null;
    return { namespace: ns, scope: rest.slice(0, dot), name: rest.slice(dot + 1) };
  }
  return null;
}

export interface ParsedAddress {
  /** The entity ref/UID (`api::x.y`, `plugin::a.b`, `shared.seo`). */
  ref: string;
  /** A method/action segment when the address is `…#method`. */
  method?: string;
}

/**
 * Parse a unified address used across the query surface: an entity ref
 * (`api::x.y`, `shared.seo`) optionally suffixed with a method
 * (`api::x.y#notify`). One grammar everywhere — `resolveRef`/`validateRef`/
 * `referencesOf` all accept it, so an agent can target a method without a
 * separate parameter. The ref part is not validated here (callers do that).
 */
export function parseAddress(address: string): ParsedAddress {
  const hash = address.indexOf('#');
  if (hash < 0) return { ref: address };
  const ref = address.slice(0, hash);
  const method = address.slice(hash + 1);
  return method ? { ref, method } : { ref };
}

/** Qualify a bare name with its plugin (`strapi.plugin('a').policy('b')` → `plugin::a.b`). */
export function qualifyPluginRef(text: string, pluginName: string | undefined): string {
  return pluginName && !text.includes('::') ? `plugin::${pluginName}.${text}` : text;
}

/** Parse a component UID `<category>.<name>`. */
export function parseComponentUid(uid: string): { category: string; name: string } | null {
  const dot = uid.indexOf('.');
  if (dot <= 0 || dot === uid.length - 1) return null;
  if (uid.indexOf('.', dot + 1) >= 0) return null; // exactly one dot
  return { category: uid.slice(0, dot), name: uid.slice(dot + 1) };
}

/** Validate the shape of a content-type / service / controller UID (no action segment). */
export function isWellFormedEntityUid(uid: string): boolean {
  const parsed = parseRef(uid);
  return parsed !== null && parsed.namespace !== 'global' && parsed.action === undefined;
}

/** Which artifact map a reference kind maps onto (helper for resolution/validation). */
export function refKindLabel(kind: ArtifactKind): string {
  return kind;
}
