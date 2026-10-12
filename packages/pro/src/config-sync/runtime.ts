/**
 * Open-source stub of the Pro config-sync runtime: the same API, without the engine. The
 * real one (private) loads the project's own Strapi and calls the real config-sync.
 */

import type { RuntimeOptions, RuntimeResult } from '../runtime/types';

const PRO_ONLY =
  'The DevKit for Strapi Pro engine (config-sync through your Strapi) is not included in the open-source build — get it at https://devkit-for-strapi.paulrichez.fr/pro/';

export type ConfigSyncDbState = 'different' | 'only-in-db' | 'only-in-sync-dir';

export interface ConfigSyncDbEntry {
  /** `<type>.<name>`, as the admin page lists it. */
  key: string;
  state: ConfigSyncDbState;
  /** The file's content as written (null: no file). */
  file: unknown;
  /** The database side, as the plugin exports it (null: not in the database). */
  db: unknown;
  /** What differs, in a few words. */
  summary: string[];
  /** Every difference, one per line (an admin role's permissions can make it long). */
  differences: string[];
}

export interface ConfigSyncDiffData {
  entries: ConfigSyncDbEntry[];
}

export interface ConfigSyncWriteData {
  /** The keys exported or imported. */
  done: string[];
  /** Asked for, but not different: nothing to do (the plugin's CLI skips them too). */
  skipped: string[];
  /** Imported, then re-exported: the database's own form of what was imported (a documentId…). */
  reexported: string[];
  /** The diff afterwards. */
  entries: ConfigSyncDbEntry[];
}

export function configSyncDiff(_root: string, _opts?: RuntimeOptions): Promise<RuntimeResult<ConfigSyncDiffData>> {
  throw new Error(PRO_ONLY);
}

/** `expected`: each key's state when the user confirmed — a key whose state changed since is left alone (a warning says so). */
export interface ConfigSyncWriteOptions extends RuntimeOptions {
  expected?: Record<string, ConfigSyncDbState>;
}

export function configSyncExport(_root: string, _keys: string[] | undefined, _opts?: ConfigSyncWriteOptions): Promise<RuntimeResult<ConfigSyncWriteData>> {
  throw new Error(PRO_ONLY);
}

export function configSyncImport(_root: string, _keys: string[], _opts?: ConfigSyncWriteOptions & { reexport?: boolean }): Promise<RuntimeResult<ConfigSyncWriteData>> {
  throw new Error(PRO_ONLY);
}
