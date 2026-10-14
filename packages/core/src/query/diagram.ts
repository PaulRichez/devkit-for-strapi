/**
 * The relations diagram of a project, as data — shared by the editor's diagram (its
 * MCD and graph views), its exports and the MCP: which types are shown, one link per
 * association (a bidirectional relation's two fields as one), the cardinalities at
 * both ends, and the fields Strapi adds to every content-type, on request — checked
 * in Strapi 4.13.5 (`@strapi/strapi/lib/core/domain/content-type`) and 5.48
 * (`@strapi/core/dist/domain/content-type`): createdAt, updatedAt, createdBy and
 * updatedBy (→ admin::user) always; publishedAt always in 5, with draft & publish in 4.
 *
 * `diagramView`, `diagramLinks`, `diagramRows` and `toMermaid` are pure (no IO, no
 * engine): the webview bundles them as they are.
 */

/** A field that isn't a link (links are drawn): what an entity lists. */
export interface DiagramAttr {
  name: string;
  type: string;
  required?: boolean;
  unique?: boolean;
  /** Added by Strapi itself (createdAt, …). */
  native?: boolean;
  /** A `customField`'s registered name. */
  customField?: string;
}

export interface DiagramNode {
  /** The UID. */
  id: string;
  label: string;
  kind: 'collectionType' | 'singleType' | 'component';
  /** `api`, `local-plugin`, `installed-plugin`, `component`, or `strapi` (Strapi's own type, not read: `admin::user`, an unread `plugin::upload.file`). */
  origin: string;
  fields: number;
  attrs: DiagramAttr[];
  draftAndPublish?: boolean;
  /** Its fields could not all be read. */
  partial?: boolean;
}

export interface DiagramEdge {
  from: string;
  to: string;
  /** The field. */
  label: string;
  /** `media`: a media field (linked to `plugin::upload.file`); `creator`: Strapi's own createdBy/updatedBy. */
  kind: 'relation' | 'component' | 'media' | 'creator';
  relation?: string;
  /** The field on the other side of a bidirectional relation (`inversedBy` / `mappedBy`). */
  inverse?: string;
  /** This side owns the relation (`inversedBy`). */
  owner?: boolean;
  /** A repeatable component, a dynamic zone, a multiple media field: "n" on the target side. */
  many?: boolean;
}

export interface DiagramData {
  root: string;
  project: string;
  projects: Array<{ root: string; name: string }>;
  /** Strapi major version (what Strapi adds to every content-type depends on it). */
  version: number;
  nodes: DiagramNode[];
  edges: DiagramEdge[];
}

export interface DiagramOptions {
  /** Show components (default false). */
  components?: boolean;
  /** Plugin types: those the project's types link to (default), or all of them. */
  allPlugins?: boolean;
  /** Media fields → the upload plugin's File (default true). */
  media?: boolean;
  /** What Strapi adds to every content-type (default false). */
  strapiFields?: boolean;
  /** Only these types and the types they link to (UIDs). */
  focus?: string[];
  /**
   * Leave out custom fields: `true` every one, or those registered under these names
   * (`plugin::layout.separator`) — a layout field (a separator, a
   * blank) has a column all the same, so none is left out by default.
   */
  hideCustomFields?: boolean | string[];
}

/** One line per association, with its cardinalities. */
export interface DiagramLink {
  from: string;
  to: string;
  label: string;
  kind: DiagramEdge['kind'];
  /** The relation kind(s), for a tooltip or a comment. */
  detail: string;
  /** Cardinality next to `from` (how many of it per one `to`), next to `to`; '' for a polymorphic relation. */
  ends: [string, string];
}

export const ADMIN_USER = 'admin::user';
export const UPLOAD_FILE = 'plugin::upload.file';

/** The types and links shown for `opts`. */
export function diagramView(data: DiagramData, opts: DiagramOptions = {}): { nodes: DiagramNode[]; edges: DiagramEdge[] } {
  const external = (n: DiagramNode): boolean => n.origin === 'installed-plugin' || n.origin === 'strapi';
  let own = data.nodes.filter((n) => !external(n) && (opts.components || n.kind !== 'component'));
  const edges = data.edges.filter((e) => opts.media !== false || e.kind !== 'media');
  if (opts.focus?.length) {
    const keep = new Set(opts.focus);
    for (const e of edges) {
      if (opts.focus.includes(e.from)) keep.add(e.to);
      if (opts.focus.includes(e.to)) keep.add(e.from);
    }
    own = own.filter((n) => keep.has(n.id));
  }
  const ownIds = new Set(own.map((n) => n.id));
  const linked = new Set<string>();
  for (const e of edges) {
    if (ownIds.has(e.from)) linked.add(e.to);
    if (ownIds.has(e.to)) linked.add(e.from);
  }
  const others = data.nodes.filter((n) => external(n) && (linked.has(n.id) || (opts.allPlugins && !opts.focus?.length && n.origin === 'installed-plugin')));
  const nodes = [...own, ...others];
  const extra: DiagramEdge[] = [];
  if (opts.strapiFields) {
    if (!nodes.some((n) => n.id === ADMIN_USER)) nodes.push({ id: ADMIN_USER, label: 'Admin user', kind: 'collectionType', origin: 'strapi', fields: 0, attrs: [] });
    for (const n of nodes) {
      if (n.kind !== 'component' && n.id !== ADMIN_USER) extra.push({ from: n.id, to: ADMIN_USER, label: 'createdBy · updatedBy', kind: 'creator' });
    }
  }
  const ids = new Set(nodes.map((n) => n.id));
  return { nodes, edges: [...edges.filter((e) => ids.has(e.from) && ids.has(e.to)), ...extra] };
}

/**
 * What an entity lists: its fields that aren't links (but the custom fields
 * `hideCustomFields` leaves out), then (with `strapiFields`) the ones Strapi adds.
 */
export function diagramRows(n: DiagramNode, version: number, strapiFields?: boolean, hideCustomFields?: DiagramOptions['hideCustomFields']): DiagramAttr[] {
  const hidden = (a: DiagramAttr): boolean =>
    a.customField !== undefined && (hideCustomFields === true || (Array.isArray(hideCustomFields) && hideCustomFields.includes(a.customField)));
  const rows: DiagramAttr[] = n.attrs.filter((a) => !hidden(a));
  if (strapiFields && n.kind !== 'component' && n.origin !== 'strapi') {
    rows.push({ name: 'createdAt', type: 'datetime', native: true }, { name: 'updatedAt', type: 'datetime', native: true });
    if (version >= 5 || n.draftAndPublish) rows.push({ name: 'publishedAt', type: 'datetime', native: true });
  }
  return rows;
}

/** The cardinalities of a link, from its declaring side. */
export function linkEnds(e: DiagramEdge): [string, string] {
  switch (e.kind) {
    case 'component':
      return ['1', e.many ? 'n' : '1'];
    case 'media':
      return ['n', e.many ? 'n' : '1'];
    case 'creator':
      return ['n', '1'];
  }
  switch (e.relation) {
    case 'oneToOne':
      return ['1', '1'];
    case 'oneToMany':
      return ['1', 'n'];
    case 'manyToOne':
    case 'oneWay':
      return ['n', '1'];
    case 'manyToMany':
    case 'manyWay':
      return ['n', 'n'];
    default:
      return ['', '']; // morph relations: polymorphic, no fixed cardinality
  }
}

/** One link per association: a bidirectional relation's two fields become one, told from its owning side. */
export function diagramLinks(edges: DiagramEdge[]): DiagramLink[] {
  const out: DiagramLink[] = [];
  const done = new Set<string>();
  for (const e of edges) {
    if (e.kind === 'relation' && e.inverse) {
      const id = [`${e.from}.${e.label}`, `${e.to}.${e.inverse}`].sort().join('|');
      if (done.has(id)) continue;
      done.add(id);
      const partner = edges.find((x) => x.kind === 'relation' && x.from === e.to && x.to === e.from && x.label === e.inverse);
      const owner = partner?.owner && !e.owner ? partner : e;
      const other = owner === e ? partner : e;
      out.push({
        from: owner.from,
        to: owner.to,
        label: other ? `${owner.label} / ${other.label}` : owner.label,
        kind: 'relation',
        detail: `${owner.from}.${owner.label} (${owner.relation ?? 'relation'})${other ? ` ⇄ ${other.from}.${other.label} (${other.relation ?? 'relation'})` : ''}`,
        ends: linkEnds(owner),
      });
      continue;
    }
    const detail =
      e.kind === 'creator'
        ? `${e.from}: createdBy, updatedBy → ${e.to} — added by Strapi to every content-type (declared oneToOne; one admin user can create many entries)`
        : e.kind === 'media'
          ? `${e.from}.${e.label}: media${e.many ? ' (multiple)' : ''} → ${e.to}`
          : `${e.from}.${e.label}${e.relation ? ` (${e.relation})` : e.kind === 'component' ? (e.many ? ' (repeatable component / dynamic zone)' : ' (component)') : ''} → ${e.to}`;
    out.push({ from: e.from, to: e.to, label: e.label, kind: e.kind, detail, ends: linkEnds(e) });
  }
  return out;
}

/** A Mermaid-safe identifier for a UID (`api::article.article` → `api_article_article`). */
function mermaidId(uid: string): string {
  return uid.replace(/[^A-Za-z0-9_]/g, '_').replace(/_+/g, '_');
}

function mermaidWord(s: string): string {
  return s.replace(/[^A-Za-z0-9_-]/g, '_') || '_';
}

const LEFT: Record<string, string> = { '1': '|o', n: '}o', '': '}o' };
const RIGHT: Record<string, string> = { '1': 'o|', n: 'o{', '': 'o{' };

/** The view as a Mermaid `erDiagram` (renders on GitHub, in docs, in most Markdown tools). */
export function toMermaid(data: DiagramData, opts: DiagramOptions = {}): { mermaid: string; entities: number; links: number } {
  const view = diagramView(data, opts);
  const links = diagramLinks(view.edges);
  const lines = ['erDiagram'];
  for (const n of view.nodes) {
    const rows = diagramRows(n, data.version, opts.strapiFields, opts.hideCustomFields);
    const head = `  ${mermaidId(n.id)}["${n.label.replace(/"/g, "'")}"]`;
    if (!rows.length) {
      lines.push(head);
      continue;
    }
    lines.push(`${head} {`);
    for (const r of rows) {
      const keys = r.unique ? ' UK' : '';
      const notes = [r.required ? 'required' : '', r.native ? 'added by Strapi' : ''].filter(Boolean).join(', ');
      lines.push(`    ${mermaidWord(r.type)} ${mermaidWord(r.name)}${keys}${notes ? ` "${notes}"` : ''}`);
    }
    lines.push('  }');
  }
  for (const l of links) {
    const line = l.kind === 'relation' ? '--' : '..';
    const label = l.ends[0] || l.ends[1] ? l.label : `${l.label} (polymorphic)`;
    lines.push(`  ${mermaidId(l.from)} ${LEFT[l.ends[0]]}${line}${RIGHT[l.ends[1]]} ${mermaidId(l.to)} : "${label.replace(/"/g, "'")}"`);
  }
  return { mermaid: lines.join('\n'), entities: view.nodes.length, links: links.length };
}
