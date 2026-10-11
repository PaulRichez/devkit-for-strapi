/**
 * A refactor plan may also edit files of config-sync's sync directory (DevKit Pro keeps
 * the roles' permissions and the content-manager views in step with the new names). Those
 * files are what the plugin imports: the database follows only once they are imported.
 *
 * Whether a refactor follows config/sync is the user's choice (a project where config/sync
 * comes from another environment leaves it alone): with it, the plan keeps its sync files
 * and says so; without, they are taken out and the note says which still use the old names.
 * Either way the agent reads it on the plan. This reads the plan's paths, nothing else.
 */

import type { FileSystem } from '../fs/FileSystem';
import { normalize } from '../fs/paths';
import type { StrapiProject, WorkspaceEdit } from '../model/types';
import { detectConfigSync } from './detect';

type PlanEdit = Pick<WorkspaceEdit, 'textEdits' | 'fileRenames'>;

/** The sync files a plan edits or renames (their current paths). */
export function syncFilesInPlan(syncDirPath: string, edit: PlanEdit): string[] {
  const dir = `${normalize(syncDirPath)}/`;
  const paths = [...edit.textEdits.map((e) => e.filePath), ...edit.fileRenames.map((r) => r.from)].map(normalize);
  return [...new Set(paths.filter((p) => p.startsWith(dir)))];
}

export interface ConfigSyncFollow<E extends PlanEdit> {
  /** The plan: as planned when refactors follow config/sync, else without its sync files. */
  edit: E;
  /** What the plan does — or leaves — in config/sync (undefined: it concerns no sync file). */
  note?: string;
}

const named = (files: string[]): string => {
  const names = files.map((f) => f.slice(f.lastIndexOf('/') + 1));
  return names.length > 4 ? `${names.slice(0, 4).join(', ')}, … ${names.length - 4} more` : names.join(', ');
};

/** The plan with or without its config/sync files (`follow`), and the note saying which. */
export async function followConfigSync<E extends PlanEdit>(fs: FileSystem, project: StrapiProject, edit: E, follow: boolean): Promise<ConfigSyncFollow<E>> {
  const detection = await detectConfigSync(fs, project);
  if (!detection) return { edit };
  const files = syncFilesInPlan(detection.syncDirPath, edit);
  if (!files.length) return { edit };
  const n = files.length === 1 ? '1 file' : `${files.length} files`;
  if (follow) {
    return {
      edit,
      note:
        `config/sync: this plan also updates ${n} of the sync directory to the new names (${named(files)}): commit them with the code. ` +
        'The database follows when they are imported (VS Code: Config Sync → Database; an agent: config_sync_import, which loads Strapi with the new code); ' +
        'the local database is shared by every branch, so import when you mean it. ' +
        'To leave config/sync as it is: `configSync: false` on the tool, or the strapiDevkit.configSync.followRefactors setting.',
    };
  }
  const inSync = new Set(files);
  const kept: E = {
    ...edit,
    textEdits: edit.textEdits.filter((e) => !inSync.has(normalize(e.filePath))),
    fileRenames: edit.fileRenames.filter((r) => !inSync.has(normalize(r.from))),
  };
  return {
    edit: kept,
    note:
      `config/sync: left as it is (refactors don't follow config/sync here) — ${n} of the sync directory still use the old names (${named(files)}): ` +
      'importing them would restore the permissions and views under the old names, not the new ones. ' +
      'Update them with the code (`configSync: true` on the tool, or the strapiDevkit.configSync.followRefactors setting), or by hand.',
  };
}

