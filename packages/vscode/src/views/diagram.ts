import { diagramOf, paths, type StrapiEngine, toMermaid } from 'devkit-for-strapi-core';
import { GET_PRO_URL } from 'devkit-for-strapi-pro';
import * as vscode from 'vscode';
import { withOffer } from '../offer';
import type { FromWebview, ToWebview } from '../webview/protocol';
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
  body { position: relative; background: var(--vscode-editor-background); color: var(--vscode-foreground); font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); display: flex; flex-direction: column; }
  .bar { display: flex; gap: 8px; align-items: center; padding: 6px 10px; border-bottom: 1px solid var(--vscode-panel-border, transparent); flex-wrap: wrap; }
  .bar input[type=search], .bar select { background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent); padding: 3px 6px; border-radius: 2px; }
  .bar input[type=search] { width: 220px; }
  .bar label { display: flex; gap: 4px; align-items: center; color: var(--vscode-descriptionForeground); }
  .bar button { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: none; padding: 4px 10px; border-radius: 2px; cursor: pointer; }
  .bar button:hover { background: var(--vscode-button-secondaryHoverBackground); }
  .seg { display: inline-flex; }
  .seg button { border-radius: 0; }
  .seg button:first-child { border-radius: 2px 0 0 2px; }
  .seg button:last-child { border-radius: 0 2px 2px 0; }
  .seg button.active { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  .spacer { flex: 1; }
  .menu { position: relative; display: inline-flex; }
  .popover { position: absolute; top: 100%; left: 0; margin-top: 4px; z-index: 10; display: flex; flex-direction: column; gap: 6px; padding: 8px 10px; white-space: nowrap; background: var(--vscode-menu-background, var(--vscode-editorWidget-background)); border: 1px solid var(--vscode-menu-border, var(--vscode-widget-border, transparent)); border-radius: 4px; box-shadow: 0 2px 8px var(--vscode-widget-shadow, rgba(0,0,0,0.35)); }
  .popover.hidden { display: none; }
  .popover label { color: var(--vscode-menu-foreground, var(--vscode-foreground)); cursor: pointer; }
  .legend.overlay { position: absolute; left: 10px; bottom: 8px; pointer-events: none; font-size: 11.5px; }
  #count, .legend { color: var(--vscode-descriptionForeground); }
  .legend span { margin-left: 10px; }
  .legend i { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin-right: 4px; border: 2px solid; vertical-align: -1px; }
  .legend i.lc { border-color: var(--vscode-charts-blue); } .legend i.ls { border-color: var(--vscode-charts-purple); } .legend i.lk { border-color: var(--vscode-charts-green); border-style: dashed; } .legend i.lp { border-color: var(--vscode-descriptionForeground); border-style: dotted; }
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
  .edge .label.start { text-anchor: start; }
  .edge line { stroke: var(--vscode-descriptionForeground); stroke-width: 1.4; }
  .edge.component line { stroke: var(--vscode-charts-green); stroke-dasharray: 5 3; }
  .edge.media line, .edge.media path { stroke: var(--vscode-charts-yellow); stroke-dasharray: 2 3; }
  .edge.creator line { stroke-dasharray: 1 4; }
  .edge .card { fill: var(--vscode-charts-orange); font-weight: 700; font-size: 12px; text-anchor: middle; }
  .node.mcd .head { fill: var(--vscode-sideBarSectionHeader-background, rgba(128,128,128,0.12)); stroke: none; }
  .node.mcd .sep { stroke: var(--vscode-widget-border, rgba(128,128,128,0.35)); }
  .node.strapi rect:first-of-type { stroke: var(--vscode-descriptionForeground); stroke-dasharray: 2 3; }
  .node .attr { fill: var(--vscode-foreground); font-size: 11.5px; font-family: var(--vscode-editor-font-family); }
  .node .attr.req { font-weight: 600; }
  .node .atype { fill: var(--vscode-descriptionForeground); font-size: 11px; text-anchor: end; font-family: var(--vscode-editor-font-family); }
  .node .native { font-style: italic; fill: var(--vscode-descriptionForeground); }
  .faded { opacity: 0.14; }
  #arrow path { fill: var(--vscode-descriptionForeground); }
  .hidden { display: none; }
  #empty { position: absolute; top: 50%; width: 100%; text-align: center; color: var(--vscode-descriptionForeground); }
</style>
</head>
<body>
  <div class="bar">
    <select id="project" title="Project"></select>
    <span class="seg"><button id="mode-mcd" title="Entities with their fields, cardinalities on straight links">MCD</button><button id="mode-graph" title="Compact boxes and arrows">Graph</button></span>
    <input id="search" type="search" placeholder="Find a type (Enter to center)">
    <span class="menu">
      <button id="options" aria-haspopup="true" aria-expanded="false" title="What the diagram shows">Options ▾</button>
      <span id="optionsPanel" class="popover hidden" role="menu">
        <label><input id="components" type="checkbox"> Components</label>
        <label title="Off: only the plugin types your types point at"><input id="allPlugins" type="checkbox"> All plugin types</label>
        <label title="Media fields, linked to the upload plugin's File"><input id="media" type="checkbox"> Media</label>
        <label title="What Strapi adds to every content-type: createdAt, updatedAt, publishedAt, and createdBy / updatedBy → admin::user"><input id="strapiFields" type="checkbox"> Strapi's fields</label>
      </span>
    </span>
    <button id="fit" title="Fit to window">Fit</button>
    <button id="relayout" title="Lay out again (unpins dragged boxes)">Re-layout</button>
    <button id="export" title="Markdown (Mermaid), PNG or SVG">Export…</button>
    <span class="spacer"></span>
    <span id="count"></span>
  </div>
  <span class="legend overlay"><span><i class="lc"></i>collection</span><span><i class="ls"></i>single</span><span><i class="lk"></i>component</span><span><i class="lp"></i>plugin</span></span>
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
    const project = engine.allProjects().find((p) => p.root === root);
    if (project) void panel.webview.postMessage({ type: 'data', data: diagramOf(project, engine.allProjects()) } satisfies ToWebview);
  };

  const save = async (ext: 'md' | 'png' | 'svg', bytes: Uint8Array): Promise<void> => {
    const filters: Record<string, string[]> = ext === 'md' ? { Markdown: ['md'] } : ext === 'png' ? { PNG: ['png'] } : { SVG: ['svg'] };
    const target = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(paths.join(root ?? '', `strapi-relations.${ext}`)), filters });
    if (!target) return;
    await vscode.workspace.fs.writeFile(target, bytes);
    void vscode.window.showInformationMessage(`Saved ${vscode.workspace.asRelativePath(target)}`);
  };

  const open = async (): Promise<void> => {
    if (!(await isLicensed())) {
      const pick = await vscode.window.showInformationMessage(withOffer('The relations diagram is a DevKit for Strapi Pro feature (the Model view stays free).'), 'Enter License Key', 'Get Pro');
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
          case 'exportMenu': {
            const pick = await vscode.window.showQuickPick(
              [
                { label: '$(markdown) Markdown (Mermaid)', description: 'an erDiagram: renders on GitHub and in most docs', format: 'md' as const },
                { label: '$(file-media) PNG', description: 'an image of the drawing, as shown', format: 'png' as const },
                { label: '$(file-code) SVG', description: 'the drawing as a vector image', format: 'svg' as const },
              ],
              { title: 'Export the relations diagram' },
            );
            if (!pick) break;
            if (pick.format === 'md') {
              const project = engine.allProjects().find((p) => p.root === root);
              if (!project) break;
              const { mermaid } = toMermaid(diagramOf(project), m.options);
              const md = `# ${paths.basename(project.root)} — data model\n\nGenerated by DevKit for Strapi from the schemas (not from a running Strapi).\n\n\`\`\`mermaid\n${mermaid}\n\`\`\`\n`;
              await save('md', Buffer.from(md, 'utf8'));
            } else {
              void panel?.webview.postMessage({ type: 'render', format: pick.format } satisfies ToWebview);
            }
            break;
          }
          case 'export':
            await save(m.format, m.format === 'png' ? Buffer.from(m.data, 'base64') : Buffer.from(m.data, 'utf8'));
            break;
        }
      },
      undefined,
      context.subscriptions,
    );
  };

  context.subscriptions.push(vscode.commands.registerCommand('strapiDevkit.model.diagram', open), { dispose: () => panel?.dispose() });
  return { refresh: send };
}
