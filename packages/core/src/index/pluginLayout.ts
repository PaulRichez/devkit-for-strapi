import { type FileSystem, FileType } from '../fs/FileSystem';
import { join } from '../fs/paths';

/** Where a local plugin keeps its server code, mirroring the layouts Strapi supports. */
export type PluginLayout = 'root' | 'server' | 'server/src';

/**
 * The effective server layout of `src/plugins/<name>`: `server/src` (the Strapi 5
 * plugin SDK scaffold, `npx @strapi/sdk-plugin init`), else `server/` (the v4
 * layout), else the plugin root. The first that exists shadows the others.
 */
export async function pluginLayoutOf(fs: FileSystem, srcDir: string, pluginName: string): Promise<PluginLayout> {
  const base = join(srcDir, 'plugins', pluginName);
  // The v5 SDK keeps sources in server/src and has no server/index.*; a v4 plugin's
  // server/index.* wins even if some unrelated server/src folder exists.
  if (await fs.exists(join(base, 'server', 'src'))) {
    let v4Entry = false;
    for (const n of ['index.js', 'index.ts', 'index.mjs', 'index.cjs']) if (await fs.exists(join(base, 'server', n))) v4Entry = true;
    if (!v4Entry) return 'server/src';
  }
  if (await fs.exists(join(base, 'server'))) return 'server';
  return 'root';
}

/** The folder holding a local plugin's server code for a given layout. */
export function layoutDir(base: string, layout: PluginLayout): string {
  return layout === 'root' ? base : join(base, layout);
}

const ENTRY_NAMES = ['index.ts', 'index.js', 'index.mts', 'index.mjs', 'index.cts', 'index.cjs'];

/**
 * The source entry of a local plugin's server — the object Strapi registers the
 * plugin's content-types, routes and artifacts from. The server folder's `index`
 * first (what `strapi-server.js` usually re-exports, in source form — it is what
 * the developer edits), else `strapi-server.*` at the plugin root.
 */
export async function localPluginEntry(fs: FileSystem, srcDir: string, name: string): Promise<string | undefined> {
  const base = join(srcDir, 'plugins', name);
  const serverDir = layoutDir(base, await pluginLayoutOf(fs, srcDir, name));
  for (const n of ENTRY_NAMES) {
    const p = join(serverDir, n);
    if ((await fs.stat(p))?.type === FileType.File) return p;
  }
  for (const n of ['strapi-server.ts', 'strapi-server.js', 'strapi-server.mjs', 'strapi-server.cjs']) {
    const p = join(base, n);
    if ((await fs.stat(p))?.type === FileType.File) return p;
  }
  return undefined;
}
