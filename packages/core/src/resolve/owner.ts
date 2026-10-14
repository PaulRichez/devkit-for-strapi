import { join, normalize } from '../fs/paths';
import { normalizeApiName } from '../index/loaderNames';
import type { StrapiProject } from '../model/types';

/** The folder (as written on disk) directly under `src/<sub>/` that holds `filePath`, if any. */
function ownerUnder(project: StrapiProject, sub: string, filePath: string): string | undefined {
  const base = join(project.srcDir, sub) + '/';
  const f = normalize(filePath);
  if (!f.toLowerCase().startsWith(base.toLowerCase())) return undefined;
  const rest = f.slice(base.length);
  const slash = rest.indexOf('/');
  return slash < 0 ? rest : rest.slice(0, slash);
}

/** API name owning a file under `src/api/<api>/...` — the folder as Strapi keys it (`normalizeName`), if any. */
export function owningApiName(project: StrapiProject, filePath: string): string | undefined {
  const folder = ownerUnder(project, 'api', filePath);
  return folder === undefined ? undefined : normalizeApiName(folder);
}

/** Plugin folder name owning a file under `src/plugins/<plugin>/...`, if any. */
export function owningPluginName(project: StrapiProject, filePath: string): string | undefined {
  return ownerUnder(project, 'plugins', filePath);
}

/**
 * Qualify a bare route handler (`'controller.action'`, Strapi's documented
 * short form for custom routes) using the file's owning api/plugin folder.
 * An already-qualified handler (`api::x.y.z`) passes through unchanged; a
 * bare handler outside any api/plugin folder is returned as-is (unverifiable
 * → the caller's own "malformed"/unknown handling applies, never guessed).
 */
export function qualifyRouteHandler(project: StrapiProject, filePath: string, text: string): string {
  if (text.includes('::')) return text;
  const plugin = owningPluginName(project, filePath);
  if (plugin) return `plugin::${plugin}.${text}`;
  const api = owningApiName(project, filePath);
  return api ? `api::${api}.${text}` : text;
}
