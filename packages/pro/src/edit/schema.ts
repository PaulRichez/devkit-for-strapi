/**
 * OPEN-SOURCE STUB — the Pro schema-edit engine is NOT in this public build.
 * Get Pro: https://devkit-for-strapi.paulrichez.fr/pro/
 */
import type { FileSystem, StrapiProject, TextEditOp } from 'devkit-for-strapi-core';

const PRO_ONLY =
  'The DevKit for Strapi Pro refactor engine is not included in the open-source build — get it at https://devkit-for-strapi.paulrichez.fr/pro/';

/** The schema-edit plan (or its errors/warnings). */
export interface SchemaEditPlan {
  ok: boolean;
  errors: string[];
  warnings: string[];
  textEdits: TextEditOp[];
  fileRenames: { from: string; to: string }[];
}

/** Pro-only in this build. */
export function planChangeRelation(
  _fs: FileSystem,
  _project: StrapiProject,
  _uid: string,
  _field: string,
  _newTarget: string,
): Promise<SchemaEditPlan> {
  throw new Error(PRO_ONLY);
}

/** Pro-only in this build. */
export function planRenameAttribute(
  _fs: FileSystem,
  _project: StrapiProject,
  _uid: string,
  _oldName: string,
  _newName: string,
): Promise<SchemaEditPlan> {
  throw new Error(PRO_ONLY);
}
