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
