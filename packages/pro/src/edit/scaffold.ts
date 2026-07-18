/**
 * OPEN-SOURCE STUB — the Pro plugin-scaffold engine is NOT in this public build.
 * Get Pro: https://devkit-for-strapi.paulrichez.fr/pro/
 */
import type { FileSystem, StrapiProject } from 'devkit-for-strapi-core';

const PRO_ONLY =
  'The DevKit for Strapi Pro refactor engine is not included in the open-source build — get it at https://devkit-for-strapi.paulrichez.fr/pro/';

/** The scaffold plan (or its errors). */
export interface ScaffoldPlan {
  ok: boolean;
  errors: string[];
  warnings: string[];
  fileCreates: { path: string; content: string }[];
}

/** Pro-only in this build. */
export function planCreatePlugin(_fs: FileSystem, _project: StrapiProject, _name: string): Promise<ScaffoldPlan> {
  throw new Error(PRO_ONLY);
}
