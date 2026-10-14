/**
 * The names Strapi's own loaders give to what they load from disk — read in
 * `@strapi/strapi` 4.26 (`dist/core/loaders/{apis,policies,middlewares}.js`) and
 * `@strapi/core` 5.12 (`src/loaders/{apis,policies,middlewares}.ts`), identical
 * on these points:
 *
 * - **APIs** (`src/api/<api>`): the API folder, each content-type folder and each
 *   file of `controllers/`, `services/`, `policies/`, `middlewares/` are keyed by
 *   `normalizeName` — kept when already kebab-case, else `_.kebabCase` (so
 *   `hasAccess.js` registers `has-access`, `foo_bar.js` registers `foo-bar`). Only
 *   the files directly in those folders are read: a subfolder is never loaded.
 * - **Global** policies and middlewares (`src/policies`, `src/middlewares`): the
 *   `.js` files directly in the folder (compiled from `.ts`), keyed by their base
 *   name as written — no normalization, no subfolder.
 * - **Plugins** register the keys of the objects their server entry exports
 *   (see `plugins/localRegistry.ts`), never a file name.
 */

import { kebabCase } from '../util/kebabCase';

/** `@strapi/utils` `isKebabCase`. */
export function isKebabCase(name: string): boolean {
  return /^([a-z][a-z0-9]*)(-[a-z0-9]+)*$/.test(name);
}

/** The API loader's `normalizeName`: the key Strapi registers an API folder, content-type folder or artifact file under. */
export function normalizeApiName(name: string): string {
  return isKebabCase(name) ? name : kebabCase(name);
}

/** Source extensions that become a `.js` file Strapi's global policy/middleware loader reads. */
const GLOBAL_EXT = ['.js', '.ts'];

/** True for a file Strapi's global policy/middleware loader registers (`.js`, or `.ts` compiled to it). */
export function isGlobalArtifactFile(name: string): boolean {
  return GLOBAL_EXT.some((e) => name.endsWith(e)) && !name.endsWith('.d.ts');
}

/**
 * Test files and mocks that live next to artifacts (`__tests__/`, `__mocks__/`,
 * `*.test.*`, `*.spec.*`): never artifacts — a plugin's index doesn't list them,
 * and a folder-convention loader must not load them at boot.
 */
export function isTestPath(relPath: string): boolean {
  const segs = relPath.split('/');
  if (segs.some((s) => s === '__tests__' || s === '__mocks__')) return true;
  return /\.(test|spec)\.[^/.]+$/.test(segs[segs.length - 1] ?? '');
}
