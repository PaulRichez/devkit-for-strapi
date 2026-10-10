/**
 * The data model of a project as Strapi registers it — every content-type (the
 * project's, local plugins', installed plugins') and component, with their fields,
 * the relations pointing at each of them (which no single file shows), and how much
 * code uses them. Pure: no IO, editor-agnostic (the panel, the MCP, the diagram).
 */

import type { AttributeInfo, ComponentInsights, ContentType, ContentTypeInsights, StrapiProject, StrapiVersion } from '../model/types';
import { buildModelMaps, componentInsights, contentTypeInsights } from '../reference/insights';

export type ModelField = Omit<AttributeInfo, 'keyOffset'> & {
  /** Char offset of the field's key in its schema file. */
  offset: number;
};

/** A field of another type pointing at this one (a relation, or a component use). */
export interface ModelIncoming {
  fromUid: string;
  fromKind: 'content-type' | 'component';
  field: string;
  /** The schema file declaring the field, and the field's key in it. */
  filePath: string;
  offset: number;
  /** The relation kind, for a relation. */
  relation?: string;
}

export interface ModelContentType {
  uid: string;
  displayName: string;
  kind: 'collectionType' | 'singleType';
  /** `api`: the project's API; `local-plugin`: `src/plugins`; `installed-plugin`: node_modules (read-only). */
  origin: 'api' | 'local-plugin' | 'installed-plugin';
  pluginName?: string;
  schemaPath: string;
  defOffset: number;
  collectionName?: string;
  draftAndPublish?: boolean;
  /** A `src/extensions` overlay: only the extension's own fields (see ContentType.extension). */
  extension?: boolean;
  /** The fields could not all be read: the list is partial. */
  partial?: boolean;
  /** Declared in code (`content-types/index.ts`), not in a `schema.json`. */
  inCode?: boolean;
  fields: ModelField[];
  /** Relations from other types to this one. */
  incoming: ModelIncoming[];
  /** References from the project's code and schemas (the CodeLens counts). */
  usage: ContentTypeInsights;
}

export interface ModelComponent {
  uid: string;
  category: string;
  name: string;
  displayName: string;
  jsonPath: string;
  defOffset: number;
  fields: ModelField[];
  /** The types whose fields use this component. */
  usedBy: ModelIncoming[];
  usage: ComponentInsights;
}

export interface ProjectModel {
  root: string;
  version: StrapiVersion;
  contentTypes: ModelContentType[];
  components: ModelComponent[];
}

const byUid = <T extends { uid: string }>(a: T, b: T): number => a.uid.localeCompare(b.uid);

function fieldsOf(attributes: Record<string, AttributeInfo>): ModelField[] {
  return Object.values(attributes).map(({ keyOffset, ...rest }) => ({ ...rest, offset: keyOffset }));
}

function originOf(ct: ContentType, localPlugins: ReadonlySet<string>): ModelContentType['origin'] {
  if (ct.installed) return 'installed-plugin';
  if (ct.source !== 'plugin') return 'api';
  // A `src/extensions/<plugin>` overlay belongs to the plugin it extends.
  return ct.pluginName && localPlugins.has(ct.pluginName) ? 'local-plugin' : 'installed-plugin';
}

/** The whole model of `project`. */
export function modelOf(project: StrapiProject): ProjectModel {
  const idx = project.index;
  const maps = buildModelMaps(project);
  const types: Array<{ ct: ContentType; inCode: boolean }> = [
    ...[...idx.contentTypes.values()].map((ct) => ({ ct, inCode: false })),
    ...[...(idx.codeContentTypes?.values() ?? [])].filter((ct) => !idx.contentTypes.has(ct.uid)).map((ct) => ({ ct, inCode: true })),
  ];

  // Who points at whom, from the fields themselves (names included).
  const incoming = new Map<string, ModelIncoming[]>();
  const usedBy = new Map<string, ModelIncoming[]>();
  const push = (m: Map<string, ModelIncoming[]>, key: string, v: ModelIncoming): void => {
    const list = m.get(key);
    if (list) list.push(v);
    else m.set(key, [v]);
  };
  const scan = (fromUid: string, fromKind: ModelIncoming['fromKind'], filePath: string, attributes: Record<string, AttributeInfo>): void => {
    for (const a of Object.values(attributes)) {
      const at = { fromUid, fromKind, field: a.name, filePath, offset: a.keyOffset };
      if (a.target) push(incoming, a.target, { ...at, ...(a.relation ? { relation: a.relation } : {}) });
      if (a.component) push(usedBy, a.component, at);
      for (const c of new Set(a.components ?? [])) push(usedBy, c, at);
    }
  };
  for (const { ct } of types) scan(ct.uid, 'content-type', ct.schemaPath, ct.attributes);
  for (const c of idx.components.values()) scan(c.uid, 'component', c.jsonPath, c.attributes);

  const contentTypes = types
    .map(({ ct, inCode }): ModelContentType => {
      const out: ModelContentType = {
        uid: ct.uid,
        displayName: ct.info.displayName ?? ct.ctName,
        kind: ct.kind,
        origin: originOf(ct, idx.pluginNames),
        schemaPath: ct.schemaPath,
        defOffset: ct.defOffset ?? 0,
        fields: fieldsOf(ct.attributes),
        // Self-relations included (`category.parent → category`): they point at it too.
        incoming: incoming.get(ct.uid) ?? [],
        usage: contentTypeInsights(project, ct.uid, maps),
      };
      if (ct.pluginName) out.pluginName = ct.pluginName;
      if (ct.collectionName) out.collectionName = ct.collectionName;
      if (ct.draftAndPublish) out.draftAndPublish = true;
      if (ct.extension) out.extension = true;
      if (ct.partialAttributes) out.partial = true;
      if (inCode) out.inCode = true;
      return out;
    })
    .sort(byUid);

  const components = [...idx.components.values()]
    .map(
      (c): ModelComponent => ({
        uid: c.uid,
        category: c.category,
        name: c.name,
        displayName: c.info.displayName ?? c.name,
        jsonPath: c.jsonPath,
        defOffset: c.defOffset ?? 0,
        fields: fieldsOf(c.attributes),
        usedBy: usedBy.get(c.uid) ?? [],
        usage: componentInsights(project, c.uid, maps),
      }),
    )
    .sort(byUid);

  return { root: project.root, version: project.version, contentTypes, components };
}
