/**
 * Open-source stub of the Pro direction of a config-sync difference: the same API,
 * without the engine. The real one (private) reads the sync files' git history.
 */

import type { ConfigSyncDbState } from './runtime';

const PRO_ONLY =
  'The DevKit for Strapi Pro engine (config-sync through your Strapi) is not included in the open-source build — get it at https://devkit-for-strapi.paulrichez.fr/pro/';

export type LikelyDirection = 'import' | 'export' | 'unknown';

export interface EntryDirection {
  likelyDirection: LikelyDirection;
  /** The evidence, in a sentence. */
  why: string;
  /** The version of the file the database holds (`ref`: a branch, or `history` for a past commit of this one). */
  dbMatches?: { ref: string; commit: string };
}

/** A version of a sync file git has: a past commit of the current branch (`history`) or another local branch's. */
export interface FileVersion {
  ref: string;
  commit: string;
  content: string;
}

export interface FileHistory {
  /** The current branch's past versions (newest first), then the other local branches' copies. */
  versions: FileVersion[];
  /** The commit (current branch) that deleted the file, when it is gone. */
  deletedIn?: string;
  /** The current branch's history has the file. */
  tracked: boolean;
  /** `false` when no commit of the current branch ever touched the sync folder (it may be gitignored): git's silence then says nothing. */
  folderTracked?: boolean;
}

export interface DirectionEntry {
  key: string;
  state: ConfigSyncDbState;
  file: unknown;
  db: unknown;
}

/** The likely direction of each difference of a config-sync diff, by key (Pro). */
export function configSyncDirections(_projectRoot: string, _syncDirPath: string, _entries: readonly DirectionEntry[]): Promise<Map<string, EntryDirection>> {
  throw new Error(PRO_ONLY);
}

/** The likely direction of one difference, from the file's history (Pro). */
export function decideDirection(_entry: DirectionEntry, _history: FileHistory | undefined): EntryDirection {
  throw new Error(PRO_ONLY);
}

/** The git history of sync files (Pro). */
export function readSyncHistory(_projectRoot: string, _files: string[]): Promise<Map<string, FileHistory>> {
  throw new Error(PRO_ONLY);
}
