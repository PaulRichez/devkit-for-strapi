/**
 * What DevKit reads of config-sync without running Strapi: the plugin, its options, and
 * the files of the sync directory with their status. Facts read from the files only —
 * what the database holds, and what a start of Strapi changes, need the real plugin.
 */

import type { FileSystem } from '../fs/FileSystem';
import type { StrapiProject } from '../model/types';
import { type ConfigSyncDetection, detectConfigSync } from './detect';
import { readSyncDir, registeredTypes, type SyncFileEntry } from './syncDir';

export interface ConfigSyncStaticStatus {
  detection: ConfigSyncDetection;
  files: SyncFileEntry[];
  /** The installed plugins are not known (still loading, or not installed): user-role and i18n-locale are assumed registered. */
  partial: boolean;
}

/** The config-sync status of `project` read from its files (undefined: config-sync isn't used there). */
export async function configSyncStatus(fs: FileSystem, project: StrapiProject): Promise<ConfigSyncStaticStatus | undefined> {
  const detection = await detectConfigSync(fs, project);
  if (!detection) return undefined;
  const types = registeredTypes(project, detection.options);
  const files = detection.syncDirExists ? await readSyncDir(fs, detection.syncDirPath, detection.options, types) : [];
  return { detection, files, partial: types === undefined };
}
