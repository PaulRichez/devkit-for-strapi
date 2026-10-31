/**
 * The sync directory (`config/sync/*.json`), read the way config-sync reads it
 * (`getAllConfigFromFiles`, 1.x and 3.x): `<type>.<name>.json`, the name stored with
 * `:` as `#` and `/` as `$`, the config key being `<type>.<name>` once unescaped. A
 * file that doesn't parse is treated as empty (the plugin warns and skips it). This
 * is the file side of the diff; the database side needs Strapi.
 */

import { type FileSystem, FileType } from '../fs/FileSystem';
import { join } from '../fs/paths';
import type { StrapiProject } from '../model/types';
import type { ConfigSyncOptions } from './detect';

/** The types config-sync registers itself (`user-role` with users-permissions, `i18n-locale` with i18n). */
export const BUILTIN_TYPES = ['core-store', 'admin-role', 'user-role', 'i18n-locale'] as const;

export type SyncFileStatus =
  | 'ok'
  | 'excluded' // matched by `excludedTypes` / `excludedConfig`: the plugin ignores it
  | 'unknown-type' // no such type registered (a plugin may register it at runtime)
  | 'invalid'; // empty or not JSON: the plugin warns and skips it

export interface SyncFileEntry {
  /** `<type>.<name>`, unescaped: what the admin page lists. */
  key: string;
  type: string;
  /** Unescaped name (`plugin_content_manager_configuration_content_types::api::article.article`). */
  name: string;
  /** The name as stored in the file name (escaped). */
  rawName: string;
  path: string;
  status: SyncFileStatus;
  /** The file's text (for positions), when readable. */
  text?: string;
  /** Parsed content, unless `invalid`. */
  content?: unknown;
}

/** File name → `{ type, rawName }`, as the plugin splits it (`type` is up to the first dot). */
export function parseSyncFileName(file: string): { type: string; rawName: string } | undefined {
  if (!file.endsWith('.json')) return undefined;
  const firstDot = file.indexOf('.');
  if (firstDot <= 0) return undefined;
  const rawName = file.slice(firstDot + 1, -'.json'.length);
  return rawName ? { type: file.slice(0, firstDot), rawName } : undefined;
}

/** Stored name → config name (`#` → `:`, `$` → `/`). */
export const unescapeName = (raw: string): string => raw.replace(/#/g, ':').replace(/\$/g, '/');
/** Config name → stored name (`:` → `#`, `/` → `$`). */
export const escapeName = (name: string): string => name.replace(/:/g, '#').replace(/\//g, '$');
/** The file name config-sync writes for a key. */
export const syncFileName = (type: string, name: string): string => `${type}.${escapeName(name)}.json`;

/**
 * Whether config-sync's import and export handle this entry: its type isn't excluded,
 * and `excludedConfig` doesn't match its key with the plain name, as they (and the
 * database side) test it (`core-store.plugin_content_manager_configuration_content_types::api::…`).
 * The plugin tests the escaped name (`##`) only when reading the sync files, for its
 * diff: `detectConfigSync` warns about an option written in one form only.
 */
export function isTracked(options: ConfigSyncOptions, type: string, name: string): boolean {
  if (options.excludedTypes.includes(type)) return false;
  const key = `${type}.${name}`;
  return !options.excludedConfig.some((opt) => key.startsWith(opt));
}

/** The types the plugin registers in this project (undefined: not known yet, e.g. plugins still loading). */
export function registeredTypes(project: StrapiProject, options: ConfigSyncOptions): Set<string> | undefined {
  const plugins = project.index.installedPlugins;
  if (!plugins) return undefined;
  const has = (name: string): boolean => plugins.has(name) || project.index.pluginNames.has(name);
  const out = new Set<string>(['core-store', 'admin-role', ...options.customTypes]);
  if (has('users-permissions')) out.add('user-role');
  if (has('i18n')) out.add('i18n-locale');
  return out;
}

/** Files read at once by {@link readSyncDir}. */
const READ_CONCURRENCY = 32;

/** Every config file of the sync directory (`[]` when it doesn't exist). */
export async function readSyncDir(fs: FileSystem, syncDirPath: string, options: ConfigSyncOptions, types?: Set<string>): Promise<SyncFileEntry[]> {
  let entries;
  try {
    entries = await fs.readDirectory(syncDirPath);
  } catch {
    return [];
  }
  const known = types ?? new Set<string>([...BUILTIN_TYPES, ...options.customTypes]);
  const read = async (fileName: string, type: string, rawName: string): Promise<SyncFileEntry> => {
    const path = join(syncDirPath, fileName);
    let text: string | undefined;
    let content: unknown;
    try {
      text = await fs.readFile(path);
      content = text.trim() ? (JSON.parse(text) as unknown) : undefined;
    } catch {
      content = undefined;
    }
    const name = unescapeName(rawName);
    const status: SyncFileStatus =
      content === undefined || content === null || typeof content !== 'object' || Array.isArray(content)
        ? 'invalid'
        : !isTracked(options, type, name)
          ? 'excluded'
          : known.has(type)
            ? 'ok'
            : 'unknown-type';
    return { key: `${type}.${name}`, type, name, rawName, path, status, ...(text !== undefined ? { text } : {}), ...(status !== 'invalid' ? { content } : {}) };
  };
  const files = entries.flatMap((e) => {
    const parsed = e.type === FileType.File ? parseSyncFileName(e.name) : undefined;
    return parsed ? [{ fileName: e.name, ...parsed }] : [];
  });
  // Read in parallel, a bounded number at a time (a large directory mustn't open every file at once).
  const out: SyncFileEntry[] = [];
  for (let i = 0; i < files.length; i += READ_CONCURRENCY) {
    out.push(...(await Promise.all(files.slice(i, i + READ_CONCURRENCY).map((f) => read(f.fileName, f.type, f.rawName)))));
  }
  return out.sort((a, b) => a.key.localeCompare(b.key));
}
