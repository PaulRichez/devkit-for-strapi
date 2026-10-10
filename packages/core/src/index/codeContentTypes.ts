/**
 * Local-plugin content-types declared in code — `content-types/index.ts`
 * exporting `{ name: { schema: { … } } }` instead of a `name/schema.json` folder.
 *
 * Strapi keys a plugin's content-types by the keys of that aggregator, so the
 * static evaluator reads them exactly as it reads installed plugins. They live
 * in `index.codeContentTypes` (not `contentTypes`, see its doc), and a plugin
 * whose aggregator can't be read exhaustively is listed in
 * `partialContentTypePlugins`: refs into it are then never reported unknown.
 */

import { type FileSystem, FileType } from '../fs/FileSystem';
import { join } from '../fs/paths';
import type { ContentType, StrapiIndex } from '../model/types';
import { isCallable, StaticEvaluator, UNKNOWN } from '../plugins/evaluate';
import { contentTypeFromDefinition } from '../plugins/installed';
import { strapiExternals } from '../plugins/shims';

const AGGREGATOR = ['index.ts', 'index.js', 'index.mjs', 'index.cjs', 'index.mts', 'index.cts'];

/** A content-type by UID, whether schema.json-based, installed or code-defined. */
export function lookupContentType(index: StrapiIndex, uid: string): ContentType | undefined {
  return index.contentTypes.get(uid) ?? index.codeContentTypes?.get(uid);
}

export function hasContentType(index: StrapiIndex, uid: string): boolean {
  return index.contentTypes.has(uid) || (index.codeContentTypes?.has(uid) ?? false);
}

/** Every content-type UID (for suggestions/completion). */
export function contentTypeUids(index: StrapiIndex): string[] {
  return [...index.contentTypes.keys(), ...(index.codeContentTypes?.keys() ?? [])];
}

/** Is this local plugin's content-type list possibly incomplete? */
export function hasPartialContentTypes(index: StrapiIndex, pluginName: string): boolean {
  return index.partialContentTypePlugins?.has(pluginName) ?? false;
}

/**
 * (Re)read the code-defined content-types of local plugin `pluginName` from its
 * `content-types` dir. Entries already indexed from a `schema.json` folder win.
 */
export async function indexCodeContentTypes(fs: FileSystem, ctDir: string, pluginName: string, index: StrapiIndex): Promise<void> {
  const prefix = `plugin::${pluginName}.`;
  for (const uid of [...(index.codeContentTypes?.keys() ?? [])]) if (uid.startsWith(prefix)) index.codeContentTypes!.delete(uid);
  index.partialContentTypePlugins?.delete(pluginName);

  let file: string | undefined;
  for (const name of AGGREGATOR) {
    const p = join(ctDir, name);
    if ((await fs.stat(p))?.type === FileType.File) {
      file = p;
      break;
    }
  }
  if (!file) return;

  const markPartial = (): void => {
    (index.partialContentTypePlugins ??= new Set()).add(pluginName);
  };
  const ev = new StaticEvaluator(fs, {}, strapiExternals);
  let v = await ev.moduleExports(file);
  if (v.k === 'obj' && v.esModule && v.props.has('default')) v = await ev.getProp(v, 'default');
  if (isCallable(v)) v = await ev.call(v, [UNKNOWN('{ strapi }')]);
  if (v.k !== 'obj') {
    if (v.k !== 'nil') markPartial();
    return;
  }
  if (v.open) markPartial();
  for (const [ctName, thunk] of v.props) {
    const uid = `${prefix}${ctName}`;
    if (index.contentTypes.has(uid)) continue; // a `<ct>/schema.json` folder — already indexed
    const ct = await contentTypeFromDefinition(ev, pluginName, ctName, await thunk(), v.keyLocs.get(ctName), file);
    (index.codeContentTypes ??= new Map()).set(uid, ct);
  }
}
