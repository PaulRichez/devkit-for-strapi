/**
 * How Strapi itself finds a policy or a middleware from the name written in a
 * route's `config` or in `config/middlewares` — read in Strapi 4.13.5
 * (`@strapi/utils/dist/policy.js#findPolicy`, `@strapi/strapi/lib/services/server/middleware.js`)
 * and 5.48 (`@strapi/core/dist/registries/policies.js#find`, `services/server/middleware.js`):
 *
 * - a policy: the exact name, then `plugin::<plugin>.<name>` for a plugin's route
 *   or `api::<api>.<name>` for an API's route — never `global::<name>`;
 * - a middleware: the exact name only (the registry keys are always namespaced).
 *
 * Not found → Strapi throws at startup (`Could not find policy`, `Middleware x not found`).
 * DevKit's navigation is wider on purpose (it also tries `global::`), so a name
 * Strapi would not find still jumps to what the author meant; this module says
 * which of the two applies.
 */

export type ScopedKind = 'policy' | 'middleware';

/** The API or plugin a route belongs to (Strapi's `route.info`). */
export interface RouteOwner {
  api?: string;
  plugin?: string;
}

/** `api::x` / `plugin::y` (a `RouteInfo.owner`) → its owner parts. */
export function ownerOf(owner: string | undefined): RouteOwner {
  if (owner?.startsWith('api::')) return { api: owner.slice('api::'.length) };
  if (owner?.startsWith('plugin::')) return { plugin: owner.slice('plugin::'.length) };
  return {};
}

/** The keys Strapi tries for `name`, in its order. */
export function strapiNameCandidates(kind: ScopedKind, name: string, owner: RouteOwner): string[] {
  if (kind === 'middleware' || name.includes('::')) return [name];
  if (owner.plugin) return [name, `plugin::${owner.plugin}.${name}`];
  if (owner.api) return [name, `api::${owner.api}.${name}`];
  return [name];
}

/** DevKit's wider lookup of a bare name (navigation): the owning API, the owning plugin, then `global::`. */
export function devkitNameCandidates(name: string, owner: RouteOwner): string[] {
  if (name.includes('::')) return [name];
  const out: string[] = [];
  if (owner.api) out.push(`api::${owner.api}.${name}`);
  if (owner.plugin) out.push(`plugin::${owner.plugin}.${name}`);
  out.push(`global::${name}`);
  return out;
}

export type NameLookup =
  /** Strapi finds it under this key. */
  | { status: 'found'; ref: string }
  /** It exists as `ref`, but Strapi won't find it under the name written: it throws at startup. */
  | { status: 'not-found-by-strapi'; ref: string }
  | { status: 'unknown' };

/** Look `name` up the way Strapi does, and say what the author meant when Strapi wouldn't find it. */
export function lookupStrapiName(
  has: (key: string) => boolean,
  kind: ScopedKind,
  name: string,
  owner: RouteOwner,
): NameLookup {
  const found = strapiNameCandidates(kind, name, owner).find(has);
  if (found) return { status: 'found', ref: found };
  const meant = devkitNameCandidates(name, owner).find(has);
  return meant ? { status: 'not-found-by-strapi', ref: meant } : { status: 'unknown' };
}

/** Why Strapi won't find `name` (for a message). */
export function whyNotFound(kind: ScopedKind, name: string, owner: RouteOwner): string {
  if (kind === 'middleware') return 'Strapi looks middlewares up by their full name only (`global::…`, `api::…`, `plugin::…`)';
  const own = owner.plugin ? `plugin::${owner.plugin}.${name}` : owner.api ? `api::${owner.api}.${name}` : undefined;
  return own
    ? `Strapi looks a route's policy up by its full name, then in the route's own ${owner.plugin ? 'plugin' : 'API'} (\`${own}\`) — never in \`global::\``
    : 'Strapi looks policies up by their full name';
}
