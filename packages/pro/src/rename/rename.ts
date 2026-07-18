/**
 * OPEN-SOURCE STUB — the Pro propagated-rename engine is NOT included in this
 * public build. The real implementation ships in the paid `devkit-for-strapi`
 * extension / `devkit-for-strapi-mcp` package. This stub only preserves the
 * public API surface so the free tier compiles and runs; the refactor itself is
 * gated behind a licence and never reached without Pro.
 *
 * Get Pro: https://devkit-for-strapi.paulrichez.fr/pro/
 */
import type { FileSystem, StrapiProject, WorkspaceEdit } from 'devkit-for-strapi-core';

const PRO_ONLY =
  'The DevKit for Strapi Pro refactor engine is not included in the open-source build — get it at https://devkit-for-strapi.paulrichez.fr/pro/';

/** What a rename target looks like before the edits are computed. */
export interface RenamePreparation {
  start: number;
  end: number;
  placeholder: string;
  /** True when only DevKit can rename this (a magic string / `any`-typed call). */
  exclusive: boolean;
}

/** Free build: never a DevKit-owned rename target → editor's native rename applies. */
export function prepareRename(
  _project: StrapiProject,
  _filePath: string,
  _offset: number,
  _text: string,
): RenamePreparation | undefined {
  return undefined;
}

/** Pro-only in this build. */
export function computeRename(
  _fs: FileSystem,
  _project: StrapiProject,
  _filePath: string,
  _offset: number,
  _text: string,
  _newName: string,
): Promise<WorkspaceEdit | null> {
  throw new Error(PRO_ONLY);
}

/** Pro-only in this build. */
export function planRename(
  _fs: FileSystem,
  _project: StrapiProject,
  _ref: string,
  _newName: string,
  _method?: string,
): Promise<WorkspaceEdit | null> {
  throw new Error(PRO_ONLY);
}
