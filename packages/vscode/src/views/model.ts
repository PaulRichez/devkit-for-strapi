import {
  CM_COMPONENT_PREFIX,
  CM_CT_PREFIX,
  type ConfigSyncStaticStatus,
  type ModelComponent,
  type ModelContentType,
  type ModelField,
  type ModelIncoming,
  modelOf,
  type ProjectModel,
  qualifiedHandler,
  type RouteInfo,
  type StrapiEngine,
  type SyncFileEntry,
} from 'devkit-for-strapi-core';
import * as vscode from 'vscode';
import { toReferenceLocations } from '../conv';
import type { ConfigSyncCache } from './configSync';
import type { RoutesView } from './routes';
import {
  CachedTree,
  code,
  isInstalledPath,
  LOADING_MESSAGE,
  markdown,
  openAt,
  orderedRoots,
  pluginsLoading,
  projectLabel,
  relPath,
  type TreeNode,
} from './tree';

/**
 * "Model" view: the data model as Strapi registers it — what no single schema file
 * shows: the fields of other types pointing at a type, the routes exposing it, how
 * much code uses it, which types use a component, and the types plugins bring from
 * node_modules (read-only). Clicking a relation or a component goes to that type.
 */

type TypeRef = { kind: 'ct'; ct: ModelContentType } | { kind: 'component'; c: ModelComponent };

type Node = TreeNode &
  (
    | { kind: 'project'; root: string }
    | { kind: 'diagram'; root: string }
    | { kind: 'section'; root: string; section: 'types' | 'components' | 'plugins' }
    | { kind: 'category'; root: string; label: string; items: ModelComponent[] }
    | { kind: 'plugin'; root: string; plugin: string; items: ModelContentType[] }
    | { kind: 'type'; root: string; type: TypeRef }
    | { kind: 'group'; root: string; type: TypeRef; group: 'fields' | 'incoming' | 'routes' | 'usedBy' }
    | { kind: 'field'; root: string; type: TypeRef; field: ModelField }
    | { kind: 'zoneItem'; root: string; uid: string; field: ModelField; type: TypeRef }
    | { kind: 'incoming'; root: string; incoming: ModelIncoming }
    | { kind: 'route'; root: string; route: RouteInfo }
    | { kind: 'usage'; root: string; ct: ModelContentType }
    | { kind: 'cmView'; root: string; uid: string; file: SyncFileEntry }
  );

const FIELD_ICON: Record<string, string> = {
  string: 'symbol-string',
  text: 'symbol-string',
  richtext: 'symbol-string',
  blocks: 'note',
  email: 'mail',
  password: 'key',
  uid: 'symbol-key',
  integer: 'symbol-number',
  biginteger: 'symbol-number',
  decimal: 'symbol-number',
  float: 'symbol-number',
  boolean: 'symbol-boolean',
  date: 'calendar',
  datetime: 'calendar',
  time: 'clock',
  timestamp: 'calendar',
  json: 'json',
  media: 'file-media',
  relation: 'link',
  component: 'symbol-structure',
  dynamiczone: 'layers',
  enumeration: 'symbol-enum',
  customField: 'symbol-misc',
};

function uidOf(t: TypeRef): string {
  return t.kind === 'ct' ? t.ct.uid : t.c.uid;
}

function fileOf(t: TypeRef): string {
  return t.kind === 'ct' ? t.ct.schemaPath : t.c.jsonPath;
}

function fieldSummary(f: ModelField, model: ProjectModel | undefined): string {
  const name = (uid: string): string => model?.contentTypes.find((c) => c.uid === uid)?.displayName ?? uid;
  const flags = [f.required ? 'required' : '', f.unique ? 'unique' : '', f.private ? 'private' : ''].filter(Boolean);
  let main: string;
  if (f.type === 'relation') main = `→ ${f.target ? name(f.target) : '?'}${f.relation ? ` (${f.relation})` : ''}`;
  else if (f.type === 'component') main = `component ${f.component ?? '?'}${f.repeatable ? ' (repeatable)' : ''}`;
  else if (f.type === 'dynamiczone') main = `dynamic zone (${f.components?.length ?? 0})`;
  else if (f.type === 'enumeration' && f.enum?.length) main = `enum ${f.enum.slice(0, 4).join(' | ')}${f.enum.length > 4 ? ' | …' : ''}`;
  else main = f.type;
  return [main, ...flags].join(' · ');
}

export class ModelProvider extends CachedTree<Node> {
  private models = new Map<string, ProjectModel>();
  private routes = new Map<string, RouteInfo[]>();
  private synced = new Map<string, ConfigSyncStaticStatus>();
  private loading: Promise<void> | undefined;
  view: vscode.TreeView<Node> | undefined;

  constructor(
    private readonly engine: StrapiEngine,
    private readonly configSync?: ConfigSyncCache,
  ) {
    super();
  }

  protected override reset(): void {
    this.models.clear();
    this.routes.clear();
    this.synced.clear();
    this.loading = undefined;
  }

  private showPluginTypes(): boolean {
    return vscode.workspace.getConfiguration('strapiDevkit.model').get<boolean>('showPluginTypes', true);
  }

  private async load(): Promise<void> {
    this.loading ??= (async () => {
      for (const p of this.engine.allProjects()) this.models.set(p.root, modelOf(p));
      try {
        for (const r of await this.engine.getRoutes({ admin: false })) this.routes.set(r.root, r.routes);
      } catch {
        /* routes are a bonus: the model stands without them */
      }
      for (const { root, status } of (await this.configSync?.all()) ?? []) this.synced.set(root, status);
      if (this.view) this.view.message = pluginsLoading(this.engine) ? LOADING_MESSAGE : undefined;
    })();
    return this.loading;
  }

  /** The content-manager view of a type, when its file is in config/sync. */
  private cmViewOf(root: string, t: TypeRef): { uid: string; file: SyncFileEntry } | undefined {
    const st = this.synced.get(root);
    if (!st) return undefined;
    const uid = uidOf(t);
    const key = `core-store.${t.kind === 'ct' ? CM_CT_PREFIX : CM_COMPONENT_PREFIX}${uid}`;
    const file = st.files.find((f) => f.key === key);
    return file ? { uid, file } : undefined;
  }

  model(root: string): ProjectModel | undefined {
    return this.models.get(root);
  }

  /** The routes calling the controller of a content-type (its core or custom actions). */
  routesOf(root: string, uid: string): RouteInfo[] {
    return (this.routes.get(root) ?? []).filter((r) => qualifiedHandler(r).startsWith(`${uid}.`) && qualifiedHandler(r).slice(uid.length + 1).indexOf('.') < 0);
  }

  protected async build(element?: Node): Promise<Node[]> {
    if (!element) {
      await this.load();
      const roots = orderedRoots(this.engine, [...this.models.keys()]);
      // The diagram, in plain sight (a title-bar icon only shows on hover).
      const diagram: Node[] = [...this.models.values()].some((m) => m.contentTypes.length) ? [{ kind: 'diagram', id: 'model|diagram', root: roots[0] ?? '' }] : [];
      if (roots.length === 1) return [...diagram, ...this.sections(roots[0]!)];
      return [...diagram, ...roots.map((root): Node => ({ kind: 'project', id: `model|${root}`, root }))];
    }
    const m = this.models.get(element.root);
    if (!m) return [];
    switch (element.kind) {
      case 'project':
        return this.sections(element.root);
      case 'section': {
        if (element.section === 'types') {
          return m.contentTypes
            .filter((ct) => ct.origin !== 'installed-plugin')
            .sort((a, b) => a.displayName.localeCompare(b.displayName))
            .map((ct) => this.typeNode(element.root, { kind: 'ct', ct }));
        }
        if (element.section === 'components') {
          const byCat = new Map<string, ModelComponent[]>();
          for (const c of m.components) byCat.set(c.category, [...(byCat.get(c.category) ?? []), c]);
          return [...byCat.entries()]
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([label, items]) => ({ kind: 'category', id: `model|${element.root}|cat|${label}`, root: element.root, label, items }));
        }
        const byPlugin = new Map<string, ModelContentType[]>();
        for (const ct of m.contentTypes.filter((c) => c.origin === 'installed-plugin')) {
          const k = ct.pluginName ?? '(unknown)';
          byPlugin.set(k, [...(byPlugin.get(k) ?? []), ct]);
        }
        return [...byPlugin.entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([plugin, items]) => ({ kind: 'plugin', id: `model|${element.root}|plugin|${plugin}`, root: element.root, plugin, items }));
      }
      case 'category':
        return element.items.map((c) => this.typeNode(element.root, { kind: 'component', c }));
      case 'plugin':
        return element.items.sort((a, b) => a.displayName.localeCompare(b.displayName)).map((ct) => this.typeNode(element.root, { kind: 'ct', ct }));
      case 'type': {
        const t = element.type;
        const base = `model|${element.root}|${uidOf(t)}`;
        const out: Node[] = [{ kind: 'group', id: `${base}|fields`, root: element.root, type: t, group: 'fields' }];
        if (t.kind === 'ct') {
          if (t.ct.incoming.length) out.push({ kind: 'group', id: `${base}|incoming`, root: element.root, type: t, group: 'incoming' });
          if (this.routesOf(element.root, t.ct.uid).length) out.push({ kind: 'group', id: `${base}|routes`, root: element.root, type: t, group: 'routes' });
          if (t.ct.origin !== 'installed-plugin') out.push({ kind: 'usage', id: `${base}|usage`, root: element.root, ct: t.ct });
        } else {
          out.push({ kind: 'group', id: `${base}|usedBy`, root: element.root, type: t, group: 'usedBy' });
        }
        const view = this.cmViewOf(element.root, t);
        if (view) out.push({ kind: 'cmView', id: `${base}|cmView`, root: element.root, ...view });
        return out;
      }
      case 'group': {
        const t = element.type;
        if (element.group === 'fields') {
          const fields = t.kind === 'ct' ? t.ct.fields : t.c.fields;
          return fields.map((field) => ({ kind: 'field', id: `${element.id}|${field.name}`, root: element.root, type: t, field }));
        }
        if (element.group === 'incoming' && t.kind === 'ct') {
          return t.ct.incoming.map((incoming) => ({ kind: 'incoming', id: `${element.id}|${incoming.fromUid}.${incoming.field}`, root: element.root, incoming }));
        }
        if (element.group === 'usedBy' && t.kind === 'component') {
          return t.c.usedBy.map((incoming) => ({ kind: 'incoming', id: `${element.id}|${incoming.fromUid}.${incoming.field}`, root: element.root, incoming }));
        }
        if (element.group === 'routes' && t.kind === 'ct') {
          return this.routesOf(element.root, t.ct.uid).map((route) => ({
            kind: 'route',
            id: `${element.id}|${route.method} ${route.fullPath ?? route.path} ${route.handler}`,
            root: element.root,
            route,
          }));
        }
        return [];
      }
      case 'field':
        if (element.field.type === 'dynamiczone') {
          return (element.field.components ?? []).map((uid) => ({ kind: 'zoneItem', id: `${element.id}|${uid}`, root: element.root, uid, field: element.field, type: element.type }));
        }
        return [];
      default:
        return [];
    }
  }

  private sections(root: string): Node[] {
    const m = this.models.get(root);
    const out: Node[] = [{ kind: 'section', id: `model|${root}|types`, root, section: 'types' }];
    if (m?.components.length) out.push({ kind: 'section', id: `model|${root}|components`, root, section: 'components' });
    if (this.showPluginTypes() && m?.contentTypes.some((c) => c.origin === 'installed-plugin')) out.push({ kind: 'section', id: `model|${root}|plugins`, root, section: 'plugins' });
    return out;
  }

  private typeNode(root: string, type: TypeRef): Node {
    return { kind: 'type', id: `model|${root}|${uidOf(type)}`, root, type };
  }

  getTreeItem(n: Node): vscode.TreeItem {
    const m = this.models.get(n.root);
    switch (n.kind) {
      case 'project': {
        const item = new vscode.TreeItem(projectLabel(n.root), vscode.TreeItemCollapsibleState.Expanded);
        item.id = n.id;
        item.tooltip = n.root;
        item.iconPath = new vscode.ThemeIcon('folder');
        return item;
      }
      case 'diagram': {
        const item = new vscode.TreeItem('Open the relations diagram', vscode.TreeItemCollapsibleState.None);
        item.id = n.id;
        item.description = 'Pro';
        item.iconPath = new vscode.ThemeIcon('type-hierarchy', new vscode.ThemeColor('charts.blue'));
        item.tooltip = 'Every content-type and its relations as a graph (DevKit for Strapi Pro).';
        item.command = { command: 'strapiDevkit.model.diagram', title: 'Open the relations diagram' };
        return item;
      }
      case 'section': {
        const label = n.section === 'types' ? 'Content-types' : n.section === 'components' ? 'Components' : 'From installed plugins';
        const item = new vscode.TreeItem(label, n.section === 'plugins' ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.Expanded);
        item.id = n.id;
        const count =
          n.section === 'types'
            ? m?.contentTypes.filter((c) => c.origin !== 'installed-plugin').length
            : n.section === 'components'
              ? m?.components.length
              : m?.contentTypes.filter((c) => c.origin === 'installed-plugin').length;
        item.description = `${count ?? 0}`;
        item.iconPath = new vscode.ThemeIcon(n.section === 'types' ? 'database' : n.section === 'components' ? 'symbol-structure' : 'extensions');
        if (n.section === 'plugins') item.tooltip = 'Content-types declared by installed plugins, read from node_modules (read-only).';
        return item;
      }
      case 'category': {
        const item = new vscode.TreeItem(n.label, vscode.TreeItemCollapsibleState.Collapsed);
        item.id = n.id;
        item.description = `${n.items.length}`;
        item.iconPath = new vscode.ThemeIcon('folder-library');
        return item;
      }
      case 'plugin': {
        const item = new vscode.TreeItem(n.plugin, vscode.TreeItemCollapsibleState.Collapsed);
        item.id = n.id;
        item.description = `${n.items.length}`;
        item.iconPath = new vscode.ThemeIcon('package');
        return item;
      }
      case 'type':
        return n.type.kind === 'ct' ? this.ctItem(n.id, n.type.ct) : this.componentItem(n.id, n.type.c);
      case 'group': {
        const t = n.type;
        const [label, count, icon] =
          n.group === 'fields'
            ? ['Fields', t.kind === 'ct' ? t.ct.fields.length : t.c.fields.length, 'list-flat']
            : n.group === 'incoming'
              ? ['Pointed at by', t.kind === 'ct' ? t.ct.incoming.length : 0, 'references']
              : n.group === 'usedBy'
                ? ['Used by', t.kind === 'component' ? t.c.usedBy.length : 0, 'references']
                : ['Routes', t.kind === 'ct' ? this.routesOf(n.root, t.ct.uid).length : 0, 'globe'];
        // Expanding a type shows its fields at once; the other groups stay folded.
        const state = !count ? vscode.TreeItemCollapsibleState.None : n.group === 'fields' ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed;
        const item = new vscode.TreeItem(label, state);
        item.id = n.id;
        item.description = n.group === 'usedBy' && !count ? 'nothing uses it' : `${count}`;
        item.iconPath = new vscode.ThemeIcon(icon);
        if (n.group === 'incoming') item.tooltip = 'Fields of other types pointing at this one (relations, self-relations included).';
        if (n.group === 'routes') item.tooltip = "Routes handled by this content-type's controller.";
        if (n.group === 'usedBy') item.tooltip = 'Fields using this component (single component or dynamic zone).';
        return item;
      }
      case 'field':
        return this.fieldItem(n, m);
      case 'zoneItem': {
        const comp = m?.components.find((c) => c.uid === n.uid);
        const item = new vscode.TreeItem(comp?.displayName ?? n.uid, vscode.TreeItemCollapsibleState.None);
        item.id = n.id;
        item.description = n.uid;
        item.iconPath = new vscode.ThemeIcon('symbol-structure');
        item.command = { command: 'strapiDevkit.model.reveal', title: 'Show component', arguments: [n.root, n.uid] };
        return item;
      }
      case 'incoming': {
        const i = n.incoming;
        const from = i.fromKind === 'content-type' ? m?.contentTypes.find((c) => c.uid === i.fromUid)?.displayName : m?.components.find((c) => c.uid === i.fromUid)?.displayName;
        const item = new vscode.TreeItem(`${from ?? i.fromUid}.${i.field}`, vscode.TreeItemCollapsibleState.None);
        item.id = n.id;
        item.description = [i.relation, i.fromUid].filter(Boolean).join(' · ');
        item.iconPath = new vscode.ThemeIcon(i.fromKind === 'component' ? 'symbol-structure' : 'arrow-small-left');
        item.tooltip = `${i.fromUid} → field \`${i.field}\`${i.relation ? ` (${i.relation})` : ''}\n${relPath(i.filePath)}`;
        item.command = { command: 'strapiDevkit.open', title: 'Open the field', arguments: [i.filePath, i.offset] };
        item.contextValue = 'strapiModel.incoming';
        return item;
      }
      case 'route': {
        const r = n.route;
        const item = new vscode.TreeItem(`${r.method.toUpperCase()} ${r.fullPath ?? r.path}`, vscode.TreeItemCollapsibleState.None);
        item.id = n.id;
        item.description = r.handler;
        item.iconPath = new vscode.ThemeIcon(r.public || r.auth?.mode === 'public' ? 'unlock' : 'lock');
        item.command = { command: 'strapiDevkit.routes.reveal', title: 'Show in Routes', arguments: [n.root, r] };
        item.tooltip = 'Show in the Routes view (with its pipeline)';
        return item;
      }
      case 'usage': {
        const u = n.ct.usage;
        const item = new vscode.TreeItem(`${u.total} reference${u.total === 1 ? '' : 's'} in code`, vscode.TreeItemCollapsibleState.None);
        item.id = n.id;
        const parts = [u.dataUsages ? `${u.dataUsages} data` : '', u.routeHandlers ? `${u.routeHandlers} route handler${u.routeHandlers === 1 ? '' : 's'}` : ''].filter(Boolean);
        item.description = u.total ? parts.join(' · ') : 'no Strapi reference found';
        item.iconPath = new vscode.ThemeIcon(u.total ? 'references' : 'circle-slash');
        item.tooltip = u.total
          ? 'Strapi magic strings and route handlers referencing this type (click to peek).'
          : 'No Strapi reference found — a dynamic access (computed UID) could still use it.';
        if (u.total) item.command = { command: 'strapiDevkit.model.references', title: 'Peek references', arguments: [n.root, n.ct.uid] };
        return item;
      }
      case 'cmView': {
        const item = new vscode.TreeItem('Content-manager view', vscode.TreeItemCollapsibleState.None);
        item.id = n.id;
        item.description = n.file.status === 'ok' ? 'in config/sync' : `in config/sync · ${n.file.status}`;
        item.iconPath = new vscode.ThemeIcon(n.file.status === 'invalid' ? 'error' : 'layout');
        const md = markdown();
        md.appendMarkdown('The layout, labels and columns of this type in the admin, as config-sync stores them.\n\n');
        md.appendMarkdown(`$(file) ${code(relPath(n.file.path))}`);
        item.tooltip = md;
        item.command = { command: 'strapiDevkit.open', title: 'Open the sync file', arguments: [n.file.path, 0] };
        return item;
      }
    }
  }

  private ctItem(id: string, ct: ModelContentType): vscode.TreeItem {
    const item = new vscode.TreeItem(ct.displayName, vscode.TreeItemCollapsibleState.Collapsed);
    item.id = id;
    const extra = [ct.partial ? 'partial' : '', ct.extension ? 'extension' : ''].filter(Boolean);
    item.description = [ct.uid, ...extra].join(' · ');
    item.iconPath = new vscode.ThemeIcon(ct.kind === 'singleType' ? 'file' : 'files');
    const md = markdown();
    md.appendMarkdown(`**${ct.displayName}** — ${ct.kind === 'singleType' ? 'single type' : 'collection type'}\n\n`);
    md.appendMarkdown(`UID ${code(ct.uid)}${ct.collectionName ? ` · table ${code(ct.collectionName)}` : ''}\n\n`);
    md.appendMarkdown(`${ct.fields.length} fields · pointed at by ${ct.incoming.length} · ${ct.usage.total} reference${ct.usage.total === 1 ? '' : 's'} in code\n\n`);
    if (ct.partial) md.appendMarkdown('$(info) Its fields could not all be read: the list is partial.\n\n');
    if (ct.extension) md.appendMarkdown('$(info) A `src/extensions` overlay: only the fields it adds or changes.\n\n');
    if (ct.origin === 'installed-plugin') md.appendMarkdown('$(package) Declared by an installed plugin (read-only).\n\n');
    else md.appendMarkdown('$(database) Strapi stores this UID in the database (permissions, media links, settings): a rename needs those rows migrated.\n\n');
    md.appendMarkdown(`$(file) ${code(relPath(ct.schemaPath))}`);
    item.tooltip = md;
    item.command = { command: 'strapiDevkit.open', title: 'Open schema', arguments: [ct.schemaPath, ct.defOffset] };
    item.contextValue = ct.origin === 'installed-plugin' || isInstalledPath(ct.schemaPath) ? 'strapiModel.type.readonly' : ct.inCode ? 'strapiModel.type.code' : 'strapiModel.type';
    return item;
  }

  private componentItem(id: string, c: ModelComponent): vscode.TreeItem {
    const item = new vscode.TreeItem(c.displayName, vscode.TreeItemCollapsibleState.Collapsed);
    item.id = id;
    item.description = c.usedBy.length ? `${c.uid} · used by ${c.usedBy.length}` : `${c.uid} · unused`;
    item.iconPath = new vscode.ThemeIcon('symbol-structure', c.usedBy.length ? undefined : new vscode.ThemeColor('descriptionForeground'));
    const md = markdown();
    md.appendMarkdown(`**${c.displayName}** — component ${code(c.uid)}\n\n`);
    md.appendMarkdown(c.usedBy.length ? `Used by ${c.usedBy.length} field${c.usedBy.length === 1 ? '' : 's'}.\n\n` : 'No type uses it.\n\n');
    md.appendMarkdown('$(database) Entries store their components by UID in the database: a rename needs those rows migrated.\n\n');
    md.appendMarkdown(`$(file) ${code(relPath(c.jsonPath))}`);
    item.tooltip = md;
    item.command = { command: 'strapiDevkit.open', title: 'Open component', arguments: [c.jsonPath, c.defOffset] };
    item.contextValue = isInstalledPath(c.jsonPath) ? 'strapiModel.component.readonly' : 'strapiModel.component';
    return item;
  }

  private fieldItem(n: Extract<Node, { kind: 'field' }>, m: ProjectModel | undefined): vscode.TreeItem {
    const f = n.field;
    const item = new vscode.TreeItem(f.name, f.type === 'dynamiczone' && f.components?.length ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
    item.id = n.id;
    item.description = fieldSummary(f, m);
    item.iconPath = new vscode.ThemeIcon(FIELD_ICON[f.type] ?? 'symbol-field');
    const md = markdown();
    md.appendMarkdown(`**${f.name}** · ${code(f.type)}\n\n`);
    if (f.target) md.appendMarkdown(`Target ${code(f.target)}${f.relation ? ` · ${f.relation}` : ''}${f.inversedBy ? ` · inversed by ${code(f.inversedBy)}` : ''}${f.mappedBy ? ` · mapped by ${code(f.mappedBy)}` : ''}\n\n`);
    if (f.component) md.appendMarkdown(`Component ${code(f.component)}${f.repeatable ? ' (repeatable)' : ''}\n\n`);
    if (f.components?.length) md.appendMarkdown(`Components ${f.components.map(code).join(', ')}\n\n`);
    if (f.enum?.length) md.appendMarkdown(`Values ${f.enum.map(code).join(', ')}\n\n`);
    const flags = [f.required ? 'required' : '', f.unique ? 'unique' : '', f.private ? 'private (not returned by the API)' : ''].filter(Boolean);
    if (flags.length) md.appendMarkdown(`${flags.join(' · ')}\n\n`);
    item.tooltip = md;
    const file = fileOf(n.type);
    if (f.type === 'relation' && f.target) item.command = { command: 'strapiDevkit.model.reveal', title: 'Show target', arguments: [n.root, f.target] };
    else if (f.type === 'component' && f.component) item.command = { command: 'strapiDevkit.model.reveal', title: 'Show component', arguments: [n.root, f.component] };
    else item.command = { command: 'strapiDevkit.open', title: 'Open in schema', arguments: [file, f.offset] };
    const readonly = n.type.kind === 'ct' ? n.type.ct.origin === 'installed-plugin' || !!n.type.ct.inCode : isInstalledPath(file);
    // A component's field: no rename/retarget from the panel yet (those handle content-types).
    item.contextValue = `strapiModel.field${f.type === 'relation' ? '.relation' : ''}${n.type.kind === 'ct' ? '' : '.component'}${readonly ? '.readonly' : ''}`;
    return item;
  }
}

export interface ModelView {
  refresh(): void;
  provider: ModelProvider;
  /** Reveal a content-type or component node. */
  reveal(root: string, uid: string, focus?: boolean): Promise<boolean>;
  visible(): boolean;
}

export function registerModelView(context: vscode.ExtensionContext, engine: StrapiEngine, routes: RoutesView, configSync?: ConfigSyncCache): ModelView {
  const provider = new ModelProvider(engine, configSync);
  const view = vscode.window.createTreeView('strapiDevkit.model', { treeDataProvider: provider, showCollapseAll: true });
  provider.view = view;

  const reveal = async (root: string, uid: string, focus = true): Promise<boolean> => {
    const into = (n: Node): boolean => n.kind === 'project' || n.kind === 'section' || n.kind === 'category' || n.kind === 'plugin';
    const node = await provider.find((n) => n.kind === 'type' && n.root === root && uidOf(n.type) === uid, into);
    if (!node && !focus) return false; // following the editor: silent
    if (!node) {
      void vscode.window.showInformationMessage(`DevKit for Strapi: '${uid}' is not in this project's model${uid.startsWith('plugin::') ? ' (an installed plugin not read, or plugin types hidden)' : ''}.`);
      return false;
    }
    await view.reveal(node, { select: true, focus, expand: true });
    return true;
  };

  context.subscriptions.push(
    view,
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('strapiDevkit.model')) provider.refresh();
    }),
    vscode.commands.registerCommand('strapiDevkit.model.reveal', (root: string, uid: string) => reveal(root, uid)),
    vscode.commands.registerCommand('strapiDevkit.model.references', async (root: string, uid: string) => {
      const project = engine.allProjects().find((p) => p.root === root);
      const ct = provider.model(root)?.contentTypes.find((c) => c.uid === uid);
      const refs = project?.references.get(`ct:${uid}`) ?? [];
      if (!ct || !refs.length) return;
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(ct.schemaPath));
      await vscode.commands.executeCommand('editor.action.showReferences', doc.uri, doc.positionAt(ct.defOffset), toReferenceLocations(refs));
    }),
    vscode.commands.registerCommand('strapiDevkit.model.openField', async (node?: Node) => {
      if (node?.kind === 'field') await openAt(fileOf(node.type), node.field.offset);
    }),
    vscode.commands.registerCommand('strapiDevkit.model.copyUid', async (node?: Node) => {
      if (node?.kind !== 'type') return;
      await vscode.env.clipboard.writeText(uidOf(node.type));
      void vscode.window.setStatusBarMessage(`Copied ${uidOf(node.type)}`, 2000);
    }),
    vscode.commands.registerCommand('strapiDevkit.model.showRoutes', async (node?: Node) => {
      if (node?.kind !== 'type' || node.type.kind !== 'ct') return;
      const uid = node.type.ct.uid;
      if (!(await routes.revealRoute(node.root, (r) => qualifiedHandler(r).startsWith(`${uid}.`)))) {
        void vscode.window.showInformationMessage(`DevKit for Strapi: no route is handled by ${uid}'s controller.`);
      }
    }),
  );
  return { refresh: () => provider.refresh(), provider, reveal, visible: () => view.visible };
}
