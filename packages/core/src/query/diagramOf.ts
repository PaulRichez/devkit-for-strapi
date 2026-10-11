import { basename } from '../fs/paths';
import type { StrapiProject } from '../model/types';
import { type DiagramData, UPLOAD_FILE } from './diagram';
import { type ModelField, modelOf } from './model';

const LINK_TYPES = new Set(['relation', 'component', 'dynamiczone', 'media']);

/** The diagram data of a project (see `query/diagram.ts`): its types, their fields, every link. */
export function diagramOf(project: StrapiProject, projects: readonly StrapiProject[] = [project]): DiagramData {
  const m = modelOf(project);
  const attrs = (fields: ModelField[]): DiagramData['nodes'][number]['attrs'] =>
    fields
      .filter((f) => !LINK_TYPES.has(f.type))
      .map((f) => ({ name: f.name, type: f.type === 'enumeration' ? 'enum' : f.type, ...(f.required ? { required: true } : {}), ...(f.unique ? { unique: true } : {}) }));
  const nodes: DiagramData['nodes'] = [
    ...m.contentTypes.map((c) => ({
      id: c.uid,
      label: c.displayName,
      kind: c.kind,
      origin: c.origin,
      fields: c.fields.length,
      attrs: attrs(c.fields),
      ...(c.draftAndPublish ? { draftAndPublish: true } : {}),
      ...(c.partial ? { partial: true } : {}),
    })),
    ...m.components.map((c) => ({ id: c.uid, label: c.displayName, kind: 'component' as const, origin: 'component', fields: c.fields.length, attrs: attrs(c.fields) })),
  ];
  const edges: DiagramData['edges'] = [];
  const add = (from: string, fields: ModelField[]): void => {
    for (const f of fields) {
      if (f.type === 'media') {
        edges.push({ from, to: UPLOAD_FILE, label: f.name, kind: 'media', ...(f.multiple ? { many: true } : {}) });
        continue;
      }
      if (f.target) {
        const inverse = f.inversedBy ?? f.mappedBy;
        edges.push({ from, to: f.target, label: f.name, kind: 'relation', ...(f.relation ? { relation: f.relation } : {}), ...(inverse ? { inverse } : {}), ...(f.inversedBy ? { owner: true } : {}) });
      }
      if (f.component) edges.push({ from, to: f.component, label: f.name, kind: 'component', ...(f.repeatable ? { many: true } : {}) });
      for (const c of new Set(f.components ?? [])) edges.push({ from, to: c, label: f.name, kind: 'component', many: true });
    }
  };
  for (const c of m.contentTypes) add(c.uid, c.fields);
  for (const c of m.components) add(c.uid, c.fields);
  // Media fields link to the upload plugin's File — shown even when the plugin wasn't read.
  if (edges.some((e) => e.kind === 'media') && !nodes.some((n) => n.id === UPLOAD_FILE)) {
    nodes.push({ id: UPLOAD_FILE, label: 'File', kind: 'collectionType', origin: 'strapi', fields: 0, attrs: [] });
  }
  // A relation to a type that wasn't read (a plugin's, before node_modules is installed; admin::user;
  // a broken target): the target stands as a node of its own, so the field isn't lost from the diagram.
  const known = new Set(nodes.map((n) => n.id));
  for (const e of edges) {
    if (e.kind !== 'relation' || known.has(e.to)) continue;
    known.add(e.to);
    nodes.push({ id: e.to, label: e.to, kind: 'collectionType', origin: 'strapi', fields: 0, attrs: [], partial: true });
  }
  return {
    root: project.root,
    project: basename(project.root),
    projects: projects.map((p) => ({ root: p.root, name: basename(p.root) })),
    version: project.version,
    nodes,
    edges,
  };
}
