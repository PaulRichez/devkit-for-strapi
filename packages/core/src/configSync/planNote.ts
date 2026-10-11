/**
 * A refactor plan may also edit files of config-sync's sync directory (DevKit Pro keeps
 * the roles' permissions and the content-manager views in step with the new names). Those
 * files are what the plugin imports: the database follows only once they are imported.
 * This note says so on the plan — it reads the plan's paths, nothing else.
 */

import type { FileSystem } from '../fs/FileSystem';
import { normalize } from '../fs/paths';
import type { StrapiProject, WorkspaceEdit } from '../model/types';
import { detectConfigSync } from './detect';

/** The sync files a plan edits or renames (their current paths). */
export function syncFilesInPlan(syncDirPath: string, edit: Pick<WorkspaceEdit, 'textEdits' | 'fileRenames'>): string[] {
  const dir = `${normalize(syncDirPath)}/`;
  const paths = [...edit.textEdits.map((e) => e.filePath), ...edit.fileRenames.map((r) => r.from)].map(normalize);
  return [...new Set(paths.filter((p) => p.startsWith(dir)))];
}

/** The caveat of a plan that edits config/sync files (undefined: it edits none). */
export async function configSyncPlanNote(fs: FileSystem, project: StrapiProject, edit: Pick<WorkspaceEdit, 'textEdits' | 'fileRenames'>): Promise<string | undefined> {
  const detection = await detectConfigSync(fs, project);
  if (!detection) return undefined;
  const files = syncFilesInPlan(detection.syncDirPath, edit);
  if (!files.length) return undefined;
  const n = files.length === 1 ? '1 file' : `${files.length} files`;
  return (
    `config/sync: this plan also updates ${n} of the sync directory (roles' permissions, content-manager views) to the new names. ` +
    'The database follows only when they are imported: once Strapi has started with this code, import them (VS Code: Config Sync → Database; an agent: config_sync_import), and commit them with the code.'
  );
}
