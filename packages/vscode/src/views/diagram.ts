import { modelOf, paths, type StrapiEngine } from 'devkit-for-strapi-core';
import { GET_PRO_URL } from 'devkit-for-strapi-pro';
import * as vscode from 'vscode';
import type { DiagramData, FromWebview, ToWebview } from '../webview/protocol';
import type { ModelView } from './model';
import { openAt, orderedRoots } from './tree';

/**
 * "Relations diagram" (Pro): the graph of a project's content-types and components —
 * relations and component uses — in a webview, updated live. Clicking a type reveals
 * it in the Model view; double-clicking opens its schema.
 */

function nonce(): string {
  let s = '';
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

export function diagramData(engine: StrapiEngine, root: string): DiagramData | undefined {
  const project = engine.allProjects().find((p) => p.root === root);
  if (!project) return undefined;
  const m = modelOf(project);
  const nodes: DiagramData['nodes'] = [
    ...m.contentTypes.map((c) => ({ id: c.uid, label: c.displayName, kind: c.kind, origin: c.origin, fields: c.fields.length })),
    ...m.components.map((c) => ({ id: c.uid, label: c.displayName, kind: 'component' as const, origin: 'component', fields: c.fields.length })),
  ];
  const edges: DiagramData['edges'] = [];
  const add = (from: string, fields: typeof m.contentTypes[number]['fields']): void => {
    for (const f of fields) {
      if (f.target) edges.push({ from, to: f.target, label: f.name, kind: 'relation', ...(f.relation ? { relation: f.relation } : {}) });
      if (f.component) edges.push({ from, to: f.component, label: f.name, kind: 'component' });
      for (const c of new Set(f.components ?? [])) edges.push({ from, to: c, label: f.name, kind: 'component' });
    }
  };
  for (const c of m.contentTypes) add(c.uid, c.fields);
  for (const c of m.components) add(c.uid, c.fields);
  const projects = engine.allProjects().map((p) => ({ root: p.root, name: paths.basename(p.root) }));
  return { root, project: paths.basename(root), projects, nodes, edges };
}

function html(webview: vscode.Webview, script: vscode.Uri): string {
  const n = nonce();
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src 'nonce-${n}'; script-src 'nonce-${n}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Strapi relations</title>
<style nonce="${n}">
  html, body { height: 100%; margin: 0; padding: 0; overflow: hidden; }
  body { background: var(--vscode-editor-background); color: var(--vscode-foreground); font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); display: flex; flex-direction: column; }
  .bar { display: flex; gap: 8px; align-items: center; padding: 6px 10px; border-bottom: 1px solid var(--vscode-panel-border, transparent); flex-wrap: wrap; }
  .bar input[type=search], .bar select { background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent); padding: 3px 6px; border-radius: 2px; }
  .bar input[type=search] { width: 220px; }
  .bar label { display: flex; gap: 4px; align-items: center; color: var(--vscode-descriptionForeground); }
  .bar button { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: none; padding: 4px 10px; border-radius: 2px; cursor: pointer; }
  .bar button:hover { background: var(--vscode-button-secondaryHoverBackground); }
  .spacer { flex: 1; }
  #count, .legend { color: var(--vscode-descriptionForeground); }
  .legend span { margin-left: 10px; }
  .legend i { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin-right: 4px; border: 2px solid; vertical-align: -1px; }
  .lc { border-color: var(--vscode-charts-blue); } .ls { border-color: var(--vscode-charts-purple); } .lk { border-color: var(--vscode-charts-green); border-style: dashed !important; } .lp { border-color: var(--vscode-descriptionForeground); border-style: dotted !important; }
  #graph { flex: 1; width: 100%; cursor: grab; user-select: none; }
  #graph:active { cursor: grabbing; }
  .node rect { fill: var(--vscode-editorWidget-background); stroke: var(--vscode-charts-blue); stroke-width: 1.5; }
  .node.singleType rect { stroke: var(--vscode-charts-purple); }
  .node.component rect { stroke: var(--vscode-charts-green); stroke-dasharray: 5 3; }
  .node.installed-plugin rect { stroke: var(--vscode-descriptionForeground); stroke-dasharray: 2 3; }
  .node.selected rect { stroke: var(--vscode-focusBorder); stroke-width: 3; }
  .node { cursor: pointer; }
  .node .name { fill: var(--vscode-foreground); font-weight: 600; font-size: 13px; }
  .node .uid { fill: var(--vscode-descriptionForeground); font-size: 10.5px; font-family: var(--vscode-editor-font-family); }
  .node .pin { fill: var(--vscode-focusBorder); }
  .edge path { fill: none; stroke: var(--vscode-descriptionForeground); stroke-width: 1.3; }
  .edge.component path { stroke-dasharray: 4 3; stroke: var(--vscode-charts-green); }
  .edge .label { fill: var(--vscode-descriptionForeground); font-size: 10.5px; text-anchor: middle; }
  .faded { opacity: 0.14; }
  #arrow path { fill: var(--vscode-descriptionForeground); }
  .hidden { display: none; }
  #empty { position: absolute; top: 50%; width: 100%; text-align: center; color: var(--vscode-descriptionForeground); }
</style>
</head>
<body>
  <div class="bar">
    <select id="project" title="Project"></select>
    <input id="search" type="search" placeholder="Find a type (Enter to center)">
    <label><input id="components" type="checkbox"> Components</label>
    <label title="Off: only the plugin types your types point at"><input id="allPlugins" type="checkbox"> All plugin types</label>
    <button id="fit" title="Fit to window">Fit</button>
    <button id="relayout" title="Lay out again (unpins dragged boxes)">Re-layout</button>
    <button id="export" title="Save as SVG">Export SVG</button>
    <span class="spacer"></span>
    <span id="count"></span>
    <span class="legend"><span><i class="lc"></i>collection</span><span><i class="ls"></i>single</span><span><i class="lk"></i>component</span><span><i class="lp"></i>plugin</span></span>
  </div>
  <svg id="graph"><defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z"/></marker></defs></svg>
  <div id="empty" class="hidden">No content-type in this project yet.</div>
  <script nonce="${n}" src="${webview.asWebviewUri(script)}"></script>
</body>
</html>`;
}

export interface DiagramPanel {
  refresh(): void;
}

export function registerDiagram(context: vscode.ExtensionContext, engine: StrapiEngine, model: ModelView, isLicensed: () => Promise<boolean>): DiagramPanel {
  let panel: vscode.WebviewPanel | undefined;
  let root: string | undefined;
  const send = (): void => {
    if (!panel || !root) return;
    const data = diagramData(engine, root);
    if (data) void panel.webview.postMessage({ type: 'data', data } satisfies ToWebview);
  };

  const open = async (): Promise<void> => {
    if (!(await isLicensed())) {
      const pick = await vscode.window.showInformationMessage('The relations diagram is a DevKit for Strapi Pro feature (the Model view stays free).', 'Enter License Key', 'Get Pro');
      if (pick === 'Enter License Key') await vscode.commands.executeCommand('strapiDevkit.enterLicenseKey');
      if (pick === 'Get Pro') await vscode.env.openExternal(vscode.Uri.parse(GET_PRO_URL));
      return;
    }
    const roots = orderedRoots(engine, engine.allProjects().map((p) => p.root));
    if (!roots.length) {
      void vscode.window.showInformationMessage('DevKit for Strapi: no Strapi project in this workspace.');
      return;
    }
    root ??= roots[0];
    if (panel) {
      panel.reveal();
      send();
      return;
    }
    const dist = vscode.Uri.joinPath(context.extensionUri, 'dist');
    panel = vscode.window.createWebviewPanel('strapiDevkit.diagram', 'Strapi relations', vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [dist],
    });
    panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'assets', 'activity.svg');
    panel.webview.html = html(panel.webview, vscode.Uri.joinPath(dist, 'diagram.js'));
    panel.onDidDispose(() => (panel = undefined), undefined, context.subscriptions);
    panel.webview.onDidReceiveMessage(
      async (m: FromWebview) => {
        switch (m.type) {
          case 'ready':
            send();
            break;
          case 'project':
            root = m.root;
            send();
            break;
          case 'reveal':
            if (root && model.visible()) void model.reveal(root, m.uid, false);
            break;
          case 'open': {
            const project = engine.allProjects().find((p) => p.root === root);
            const ct = project?.index.contentTypes.get(m.uid) ?? project?.index.codeContentTypes?.get(m.uid);
            const comp = project?.index.components.get(m.uid);
            const file = ct?.schemaPath ?? comp?.jsonPath;
            if (file) await openAt(file, ct?.defOffset ?? comp?.defOffset ?? 0);
            break;
          }
          case 'export': {
            const target = await vscode.window.showSaveDialog({
              defaultUri: vscode.Uri.file(paths.join(root ?? '', 'strapi-relations.svg')),
              filters: { SVG: ['svg'] },
            });
            if (target) {
              await vscode.workspace.fs.writeFile(target, Buffer.from(m.svg, 'utf8'));
              void vscode.window.showInformationMessage(`Saved ${vscode.workspace.asRelativePath(target)}`);
            }
            break;
          }
        }
      },
      undefined,
      context.subscriptions,
    );
  };

  context.subscriptions.push(vscode.commands.registerCommand('strapiDevkit.model.diagram', open), { dispose: () => panel?.dispose() });
  return { refresh: send };
}
