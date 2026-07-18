/**
 * OPEN-SOURCE STUB — the Pro move / extract engine is NOT in this public build.
 * Get Pro: https://devkit-for-strapi.paulrichez.fr/pro/
 */
import type { FileSystem, StrapiProject, TextEditOp } from 'devkit-for-strapi-core';

const PRO_ONLY =
  'The DevKit for Strapi Pro refactor engine is not included in the open-source build — get it at https://devkit-for-strapi.paulrichez.fr/pro/';

/** One artifact/entity to relocate. */
export interface MoveSpec {
  ref: string;
  toNamespace?: string;
  allowNewNamespace?: boolean;
}

export interface MoveOptions {
  [key: string]: unknown;
}

/** The move plan (or its errors). */
export interface MovePlan {
  ok: boolean;
  errors: string[];
  warnings: string[];
  textEdits: TextEditOp[];
  fileRenames: { from: string; to: string }[];
}

/** Pro-only in this build. */
export function planMove(
  _fs: FileSystem,
  _project: StrapiProject,
  _specs: MoveSpec[],
  _options?: MoveOptions,
): Promise<MovePlan> {
  throw new Error(PRO_ONLY);
}
