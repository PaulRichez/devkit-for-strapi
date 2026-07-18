import { paths } from 'devkit-for-strapi-core';
import type { FileSystem, StrapiEngine } from 'devkit-for-strapi-core';
import { computeRename, prepareRename as prepareRenameAt } from 'devkit-for-strapi-pro';
import * as vscode from 'vscode';
import { DOCUMENT_SELECTOR, docPath } from '../selector';

/**
 * Native rename (F2) on a Strapi magic string or a service/controller method.
 * Pro feature: the rename engine lives in `devkit-for-strapi-pro`; the provider
 * resolves the owning project via the (free) engine and delegates the compute.
 */
export function registerRenameProvider(
  context: vscode.ExtensionContext,
  engine: StrapiEngine,
  fs: FileSystem,
  isLicensed: () => Promise<boolean>,
): void {
  context.subscriptions.push(
    vscode.languages.registerRenameProvider(DOCUMENT_SELECTOR, {
      async prepareRename(document, position) {
        const filePath = paths.normalize(docPath(document));
        const project = engine.projectForFile(filePath);
        if (!project) return undefined; // not a Strapi project we own → native rename
        const prep = prepareRenameAt(project, filePath, document.offsetAt(position), document.getText());
        if (!prep) return undefined; // not a DevKit rename target → native rename
        if (!(await isLicensed())) {
          // A method *declaration* (TS owns the symbol too): step aside so the
          // editor's native rename still works — never block a free user from
          // renaming their own code.
          if (!prep.exclusive) return undefined;
          // DevKit-exclusive (a magic string / `any`-typed call-site that native
          // rename can't touch) and it's Pro → surface the upsell, not a no-op.
          throw new Error(
            'Propagated rename is a DevKit for Strapi Pro feature — run "DevKit for Strapi: Enter License Key" to unlock it.',
          );
        }
        return {
          range: new vscode.Range(document.positionAt(prep.start), document.positionAt(prep.end)),
          placeholder: prep.placeholder,
        };
      },
      async provideRenameEdits(document, position, newName) {
        if (!(await isLicensed())) return undefined;
        const filePath = paths.normalize(docPath(document));
        const project = engine.projectForFile(filePath);
        if (!project) return undefined;
        const result = await computeRename(
          fs,
          project,
          filePath,
          document.offsetAt(position),
          document.getText(),
          newName,
        );
        if (!result) return undefined;
        const edit = new vscode.WorkspaceEdit();
        // Text edits first, then creates, renames, deletes (they move/remove the edited files).
        for (const t of result.textEdits) {
          edit.replace(
            vscode.Uri.file(t.filePath),
            new vscode.Range(t.start.line, t.start.character, t.end.line, t.end.character),
            t.newText,
          );
        }
        for (const c of result.fileCreates ?? []) {
          edit.createFile(vscode.Uri.file(c.path), { overwrite: false, contents: Buffer.from(c.content) });
        }
        for (const r of result.fileRenames) {
          edit.renameFile(vscode.Uri.file(r.from), vscode.Uri.file(r.to), { overwrite: false });
        }
        for (const d of result.fileDeletes ?? []) {
          edit.deleteFile(vscode.Uri.file(d), { ignoreIfNotExists: true });
        }
        return edit;
      },
    }),
  );
}
