/**
 * What the users-permissions roles in the sync files say about a route: which roles
 * may call its action. It is what the database will hold after an import — the
 * database itself may differ (an admin change not exported yet), and the label says so.
 */

import { INLINE_ENTRY, type RouteInfo } from '../model/types';
import { qualifiedHandler } from '../query/routePipeline';
import type { SyncFileEntry } from './syncDir';

export interface RouteRoleAccess {
  /** Roles (by `type`: `public`, `authenticated`, …) whose permissions include the action. */
  allowed: string[];
  /** Roles found in the files that don't include it. */
  denied: string[];
  /** The role files read. */
  files: string[];
}

/** Access to `action` (`api::article.article.find`) according to the `user-role.*` sync files. */
export function routeAccessInSync(entries: SyncFileEntry[], action: string): RouteRoleAccess | undefined {
  const roles = entries.filter((e) => e.type === 'user-role' && e.status === 'ok');
  if (!roles.length) return undefined;
  const allowed: string[] = [];
  const denied: string[] = [];
  for (const r of roles) {
    const content = r.content as { permissions?: Array<{ action?: unknown }> } | undefined;
    const perms = Array.isArray(content?.permissions) ? content!.permissions : [];
    (perms.some((p) => p.action === action) ? allowed : denied).push(r.name);
  }
  return { allowed, denied, files: roles.map((r) => r.path) };
}

/**
 * For a content-API route under the default auth: its action, and which synced roles
 * allow it. Undefined when the roles don't decide it (`auth: false`, a custom
 * `config.auth`, an admin route, an inline handler) or no role file is synced.
 */
export function routeAccessForRoute(route: RouteInfo, entries: SyncFileEntry[]): (RouteRoleAccess & { action: string }) | undefined {
  if (route.auth || route.public || route.type === 'admin' || route.handler === INLINE_ENTRY) return undefined;
  const action = qualifiedHandler(route);
  if (!action.includes('::')) return undefined;
  const access = routeAccessInSync(entries, action);
  return access && { action, ...access };
}
