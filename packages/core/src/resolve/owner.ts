import { join, normalize } from '../fs/paths';
import type { StrapiProject } from '../model/types';

function ownerUnder(project: StrapiProject, sub: string, filePath: string): string | undefined {
  const base = join(project.srcDir, sub).toLowerCase() + '/';
  const f = normalize(filePath).toLowerCase();
  if (!f.startsWith(base)) return undefined;
  const rest = f.slice(base.length);
  const slash = rest.indexOf('/');
  return slash < 0 ? rest : rest.slice(0, slash);
}

/** API folder name owning a file under `src/api/<api>/...`, if any. */
export function owningApiName(project: StrapiProject, filePath: string): string | undefined {
  return ownerUnder(project, 'api', filePath);
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
