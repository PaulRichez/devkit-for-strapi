import { paths, qualifiedHandler, type StrapiEngine } from 'devkit-for-strapi-core';
import * as vscode from 'vscode';
import type { ModelView } from './model';
import type { RoutesView } from './routes';

/**
 * "Reveal in DevKit" for the file in the editor — a schema in Model, a controller
 * or a route file in Routes — and, with `strapiDevkit.views.followActiveEditor`,
 * the same on every editor switch, in the views that are open (never stealing focus).
 */

type Target = { view: 'model'; root: string; uid: string } | { view: 'routes'; root: string; controller?: string; routeFile?: string };

function targetOf(engine: StrapiEngine, fsPath: string): Target | undefined {
  const file = paths.normalize(fsPath);
  const project = engine.projectForFile(file);
  if (!project) return undefined;
  const idx = project.index;
  const same = (p: string): boolean => paths.normalize(p) === file;
  for (const ct of [...idx.contentTypes.values(), ...(idx.codeContentTypes?.values() ?? [])]) if (same(ct.schemaPath)) return { view: 'model', root: project.root, uid: ct.uid };
  for (const c of idx.components.values()) if (same(c.jsonPath)) return { view: 'model', root: project.root, uid: c.uid };
  for (const c of idx.controllers.values()) if (same(c.filePath)) return { view: 'routes', root: project.root, controller: c.ref };
  if (/\/routes\/[^/]+\.[cm]?[jt]s$/.test(file)) return { view: 'routes', root: project.root, routeFile: file };
  return undefined;
}

/** `follow`: an editor switch — no focus, no message, no filter cleared. */
async function reveal(t: Target, model: ModelView, routes: RoutesView, follow: boolean): Promise<boolean> {
  if (t.view === 'model') return model.reveal(t.root, t.uid, !follow);
  return routes.revealRoute(
    t.root,
    (r) => (t.controller ? qualifiedHandler(r).startsWith(`${t.controller}.`) : !!r.filePath && paths.normalize(r.filePath) === t.routeFile),
    !follow,
    follow,
  );
}

export function registerFollow(context: vscode.ExtensionContext, engine: StrapiEngine, model: ModelView, routes: RoutesView): void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  context.subscriptions.push(
    vscode.commands.registerCommand('strapiDevkit.revealInPanel', async (uri?: vscode.Uri) => {
      const fsPath = uri?.fsPath ?? vscode.window.activeTextEditor?.document.uri.fsPath;
      const t = fsPath ? targetOf(engine, fsPath) : undefined;
      if (!t) {
        void vscode.window.showInformationMessage('DevKit for Strapi: this file is not a content-type schema, a component, a controller or a route file DevKit knows.');
        return;
      }
      // The Model view says itself when a type is missing; Routes doesn't.
      if (!(await reveal(t, model, routes, false)) && t.view === 'routes') {
        void vscode.window.showInformationMessage(`DevKit for Strapi: no route ${t.controller ? 'is handled by this controller' : 'is declared in this file'}.`);
      }
    }),
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (!editor || !vscode.workspace.getConfiguration('strapiDevkit.views').get<boolean>('followActiveEditor', true)) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        const t = targetOf(engine, editor.document.uri.fsPath);
        if (!t) return;
        // Only in an open view, without focus: following must never move the user.
        if (t.view === 'model' ? model.visible() : routes.visible()) void reveal(t, model, routes, true);
      }, 200);
    }),
    { dispose: () => timer && clearTimeout(timer) },
  );
}
