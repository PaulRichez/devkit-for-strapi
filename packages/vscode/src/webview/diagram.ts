/**
 * The relations diagram, in a webview: content-types and components as boxes,
 * relations and component uses as arrows. A deterministic force layout (no
 * dependency), pan and zoom, drag a box to pin it, click to light up its neighbours
 * (and reveal it in the Model view), double-click to open its schema, search,
 * filters, export to SVG. Data comes from the extension (`modelOf`), live.
 */

import type { DiagramData, DiagramEdge, DiagramNode, FromWebview, ToWebview } from './protocol';

declare function acquireVsCodeApi(): { postMessage(m: FromWebview): void; getState(): unknown; setState(s: unknown): void };

const vscode = acquireVsCodeApi();
const SVG = 'http://www.w3.org/2000/svg';

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
  pinned?: boolean;
}

interface Saved {
  positions: Record<string, Record<string, Box>>;
  view: Record<string, { x: number; y: number; k: number }>;
  components: boolean;
  allPlugins: boolean;
}

const saved: Saved = { positions: {}, view: {}, components: false, allPlugins: false, ...((vscode.getState() as Partial<Saved> | undefined) ?? {}) };
let data: DiagramData | undefined;
let boxes = new Map<string, Box>();
let view = { x: 0, y: 0, k: 1 };
let selected: string | undefined;
let search = '';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const svg = document.getElementById('graph') as unknown as SVGSVGElement;
const layer = document.createElementNS(SVG, 'g');
svg.appendChild(layer);

function persist(): void {
  if (!data) return;
  saved.positions[data.root] = Object.fromEntries(boxes);
  saved.view[data.root] = view;
  vscode.setState(saved);
}

// ---------------------------------------------------------------------------
// What is shown
// ---------------------------------------------------------------------------

function visible(): { nodes: DiagramNode[]; edges: DiagramEdge[] } {
  if (!data) return { nodes: [], edges: [] };
  const own = data.nodes.filter((n) => n.origin !== 'installed-plugin' && (saved.components || n.kind !== 'component'));
  const ownIds = new Set(own.map((n) => n.id));
  // Installed plugins' types: only those the project's types point at, unless asked for all.
  const linked = new Set<string>();
  for (const e of data.edges) {
    if (ownIds.has(e.from)) linked.add(e.to);
    if (ownIds.has(e.to)) linked.add(e.from);
  }
  const plugins = data.nodes.filter((n) => n.origin === 'installed-plugin' && (saved.allPlugins || linked.has(n.id)));
  const nodes = [...own, ...plugins];
  const ids = new Set(nodes.map((n) => n.id));
  return { nodes, edges: data.edges.filter((e) => ids.has(e.from) && ids.has(e.to)) };
}

// ---------------------------------------------------------------------------
// Layout: forces, then no overlap
// ---------------------------------------------------------------------------

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function sizeOf(n: DiagramNode): { w: number; h: number } {
  return { w: Math.max(n.label.length * 8, n.id.length * 6.2) + 28, h: 42 };
}

/** Connected groups of types (union-find over the links). */
function components(nodes: DiagramNode[], edges: DiagramEdge[]): DiagramNode[][] {
  const parent = new Map(nodes.map((n) => [n.id, n.id]));
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    parent.set(x, r);
    return r;
  };
  for (const e of edges) if (parent.has(e.from) && parent.has(e.to)) parent.set(find(e.from), find(e.to));
  const groups = new Map<string, DiagramNode[]>();
  for (const n of nodes) groups.set(find(n.id), [...(groups.get(find(n.id)) ?? []), n]);
  return [...groups.values()];
}

/** Forces (Fruchterman–Reingold) within one connected group; pinned boxes stay. */
function settle(list: Box[], links: Array<[number, number]>, steps: number, rand: () => number): void {
  const k = 170;
  for (let it = 0; it < steps; it++) {
    const dx = new Float64Array(list.length);
    const dy = new Float64Array(list.length);
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        let ex = list[i]!.x - list[j]!.x;
        const ey = list[i]!.y - list[j]!.y;
        if (ex === 0 && ey === 0) ex = rand() - 0.5;
        const f = (k * k) / Math.max(ex * ex + ey * ey, 1);
        dx[i] += ex * f;
        dy[i] += ey * f;
        dx[j] -= ex * f;
        dy[j] -= ey * f;
      }
    }
    for (const [i, j] of links) {
      const ex = list[i]!.x - list[j]!.x;
      const ey = list[i]!.y - list[j]!.y;
      const f = Math.sqrt(ex * ex + ey * ey) / k;
      dx[i] -= ex * f;
      dy[i] -= ey * f;
      dx[j] += ex * f;
      dy[j] += ey * f;
    }
    const temp = (k * (1 - it / steps)) / 2 + 2;
    for (let i = 0; i < list.length; i++) {
      const b = list[i]!;
      if (b.pinned) continue;
      dx[i] -= b.x * 0.04; // a little gravity: chains don't drift away
      dy[i] -= b.y * 0.04;
      const len = Math.sqrt(dx[i]! * dx[i]! + dy[i]! * dy[i]!) || 1;
      const m = Math.min(len, temp);
      b.x += (dx[i]! / len) * m;
      b.y += (dy[i]! / len) * m;
    }
  }
}

/** Push overlapping boxes apart (with a margin); pinned ones don't move. */
function separate(list: Box[]): void {
  for (let pass = 0; pass < 80; pass++) {
    let moved = false;
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i]!;
        const b = list[j]!;
        // Room between boxes for the link labels.
        const ox = (a.w + b.w) / 2 + 60 - Math.abs(a.x - b.x);
        const oy = (a.h + b.h) / 2 + 56 - Math.abs(a.y - b.y);
        if (ox <= 0 || oy <= 0) continue;
        moved = true;
        const [sa, sb] = a.pinned ? [0, 1] : b.pinned ? [1, 0] : [0.5, 0.5];
        if (ox < oy) {
          const s = a.x < b.x ? -1 : 1;
          a.x += s * ox * sa;
          b.x -= s * ox * sb;
        } else {
          const s = a.y < b.y ? -1 : 1;
          a.y += s * oy * sa;
          b.y -= s * oy * sb;
        }
      }
    }
    if (!moved) break;
  }
}

function bounds(list: Box[]): { minX: number; minY: number; maxX: number; maxY: number } {
  return {
    minX: Math.min(...list.map((b) => b.x - b.w / 2)),
    minY: Math.min(...list.map((b) => b.y - b.h / 2)),
    maxX: Math.max(...list.map((b) => b.x + b.w / 2)),
    maxY: Math.max(...list.map((b) => b.y + b.h / 2)),
  };
}

/**
 * Lay the types out: each connected group by forces, the groups then shelved in rows
 * (largest first, lone types last) so nothing drifts away. An update keeps every box
 * already placed and only places the new ones next to their neighbours.
 */
function layout(nodes: DiagramNode[], edges: DiagramEdge[], fresh: boolean): void {
  const rand = rng(nodes.length * 7919 + edges.length);
  const prev = fresh ? new Map<string, Box>() : boxes;
  const next = new Map<string, Box>();
  const sized = (n: DiagramNode): { w: number; h: number } => sizeOf(n);
  const known = nodes.filter((n) => prev.has(n.id));

  if (known.length && !fresh) {
    for (const n of nodes) {
      const old = prev.get(n.id);
      if (old) next.set(n.id, { ...old, ...sized(n) });
    }
    const placed = [...next.values()];
    const b = bounds(placed);
    let spill = 0;
    for (const n of nodes) {
      if (next.has(n.id)) continue;
      const near = edges
        .filter((e) => e.from === n.id || e.to === n.id)
        .map((e) => next.get(e.from === n.id ? e.to : e.from))
        .filter((x): x is Box => !!x);
      const at = near.length
        ? { x: near.reduce((s, x) => s + x.x, 0) / near.length + (rand() - 0.5) * 120, y: near.reduce((s, x) => s + x.y, 0) / near.length + (rand() - 0.5) * 120 }
        : { x: b.minX + 120 + (spill++ % 8) * 240, y: b.maxY + 90 + Math.floor(spill / 8) * 80 };
      next.set(n.id, { ...at, ...sized(n) });
    }
    separate([...next.values()]);
    boxes = next;
    return;
  }

  const groups = components(nodes, edges).sort((a, b) => b.length - a.length);
  const placedGroups: Array<{ list: Box[]; w: number; h: number }> = [];
  for (const g of groups) {
    const index = new Map(g.map((n, i) => [n.id, i]));
    const list = g.map((n, i): Box => {
      const a = i * 2.399963; // golden-angle spiral start
      const r = 70 * Math.sqrt(i);
      return { x: Math.cos(a) * r, y: Math.sin(a) * r, ...sized(n) };
    });
    const links: Array<[number, number]> = [];
    for (const e of edges) {
      const i = index.get(e.from);
      const j = index.get(e.to);
      if (i !== undefined && j !== undefined && i !== j) links.push([i, j]);
    }
    if (list.length > 1) settle(list, links, 300, rand);
    separate(list);
    const b = bounds(list);
    for (const box of list) {
      box.x -= b.minX;
      box.y -= b.minY;
    }
    g.forEach((n, i) => next.set(n.id, list[i]!));
    placedGroups.push({ list, w: b.maxX - b.minX, h: b.maxY - b.minY });
  }
  // Shelf packing: rows about as wide as the drawing is tall.
  const gap = 70;
  const area = placedGroups.reduce((s, g) => s + (g.w + gap) * (g.h + gap), 0);
  const rowWidth = Math.max(placedGroups[0]?.w ?? 0, Math.sqrt(area) * 1.5);
  let x = 0;
  let y = 0;
  let row = 0;
  for (const g of placedGroups) {
    if (x > 0 && x + g.w > rowWidth) {
      x = 0;
      y += row + gap;
      row = 0;
    }
    for (const box of g.list) {
      box.x += x;
      box.y += y;
    }
    x += g.w + gap;
    row = Math.max(row, g.h);
  }
  boxes = next;
}

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------

function el<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>, parent?: Element): SVGElementTagNameMap[K] {
  const e = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  parent?.appendChild(e);
  return e;
}

/** Where the segment from the centre of `b` towards (tx, ty) leaves the box. */
function border(b: Box, tx: number, ty: number): [number, number] {
  const dx = tx - b.x;
  const dy = ty - b.y;
  if (!dx && !dy) return [b.x, b.y];
  const sx = dx ? b.w / 2 / Math.abs(dx) : Infinity;
  const sy = dy ? b.h / 2 / Math.abs(dy) : Infinity;
  const s = Math.min(sx, sy);
  return [b.x + dx * s, b.y + dy * s];
}

function draw(): void {
  layer.replaceChildren();
  layer.setAttribute('transform', `translate(${view.x},${view.y}) scale(${view.k})`);
  const { nodes, edges } = visible();
  const q = search.trim().toLowerCase();
  const hits = q ? new Set(nodes.filter((n) => n.label.toLowerCase().includes(q) || n.id.toLowerCase().includes(q)).map((n) => n.id)) : undefined;
  const near = new Set<string>();
  if (selected) {
    near.add(selected);
    for (const e of edges) {
      if (e.from === selected) near.add(e.to);
      if (e.to === selected) near.add(e.from);
    }
  }
  const lit = (id: string): boolean => (hits ? hits.has(id) : selected ? near.has(id) : true);

  // More than two fields from one type to another: one link, "N fields" (listed in its tooltip).
  const byPair = new Map<string, DiagramEdge[]>();
  for (const e of edges) byPair.set(`${e.from}|${e.to}`, [...(byPair.get(`${e.from}|${e.to}`) ?? []), e]);
  const drawn: Array<{ e: DiagramEdge; title: string }> = [];
  for (const list of byPair.values()) {
    const describe = (e: DiagramEdge): string => `${e.label}${e.relation ? ` (${e.relation})` : ''}`;
    if (list.length > 2) {
      const e0 = list[0]!;
      drawn.push({
        e: { from: e0.from, to: e0.to, label: `${list.length} fields`, kind: list.every((x) => x.kind === 'component') ? 'component' : 'relation' },
        title: `${e0.from} → ${e0.to}\n${list.map(describe).join('\n')}`,
      });
    } else for (const e of list) drawn.push({ e, title: `${e.from}.${describe(e)} → ${e.to}` });
  }
  const pairCount = new Map<string, number>();
  const edgeLayer = el('g', {}, layer);
  for (const { e, title: tip } of drawn) {
    const a = boxes.get(e.from);
    const b = boxes.get(e.to);
    if (!a || !b) continue;
    const on = selected ? e.from === selected || e.to === selected : !hits || (hits.has(e.from) && hits.has(e.to));
    const g = el('g', { class: `edge ${e.kind}${on ? '' : ' faded'}` }, edgeLayer);
    const title = el('title', {}, g);
    title.textContent = tip;
    if (e.from === e.to) {
      const x = a.x + a.w / 2 - 12;
      const y = a.y - a.h / 2;
      el('path', { d: `M ${x - 18} ${y} C ${x - 18} ${y - 46}, ${x + 40} ${y - 46}, ${x + 12} ${y + 2}`, 'marker-end': 'url(#arrow)' }, g);
      if (view.k >= 0.7 || on) el('text', { x: x + 10, y: y - 40, class: 'label' }, g).textContent = e.label;
      continue;
    }
    const key = [e.from, e.to].sort().join('|');
    const nth = pairCount.get(key) ?? 0;
    pairCount.set(key, nth + 1);
    const [x1, y1] = border(a, b.x, b.y);
    const [x2, y2] = border(b, a.x, a.y);
    const mx = (x1 + x2) / 2;
    const my = (y1 + y2) / 2;
    // Several fields between the same two types: fan the curves out.
    const bend = nth === 0 ? 0 : (nth % 2 ? 1 : -1) * Math.ceil(nth / 2) * 34;
    const len = Math.hypot(x2 - x1, y2 - y1) || 1;
    const cx = mx + (-(y2 - y1) / len) * bend;
    const cy = my + ((x2 - x1) / len) * bend;
    el('path', { d: `M ${x1} ${y1} Q ${cx} ${cy} ${x2} ${y2}`, 'marker-end': 'url(#arrow)' }, g);
    if (view.k >= 0.6 || on) {
      // A third of the way from the source: the two directions of a pair don't collide.
      const t = 0.33;
      const lx = (1 - t) * (1 - t) * x1 + 2 * (1 - t) * t * cx + t * t * x2;
      const ly = (1 - t) * (1 - t) * y1 + 2 * (1 - t) * t * cy + t * t * y2;
      const text = el('text', { x: lx, y: ly - 4, class: 'label' }, g);
      text.textContent = on && selected && e.relation ? `${e.label} · ${e.relation}` : e.label;
    }
  }

  for (const n of nodes) {
    const b = boxes.get(n.id);
    if (!b) continue;
    const g = el('g', { class: `node ${n.kind} ${n.origin}${lit(n.id) ? '' : ' faded'}${selected === n.id ? ' selected' : ''}`, transform: `translate(${b.x - b.w / 2},${b.y - b.h / 2})`, 'data-id': n.id }, layer);
    el('title', {}, g).textContent = `${n.label} — ${n.id}\n${n.kind === 'component' ? 'component' : n.kind === 'singleType' ? 'single type' : 'collection type'} · ${n.fields} fields${n.origin === 'installed-plugin' ? ' · installed plugin (read-only)' : ''}`;
    el('rect', { width: b.w, height: b.h, rx: 7 }, g);
    el('text', { x: 14, y: 18, class: 'name' }, g).textContent = n.label;
    el('text', { x: 14, y: 33, class: 'uid' }, g).textContent = n.id;
    if (b.pinned) el('circle', { cx: b.w - 9, cy: 9, r: 3, class: 'pin' }, g);
  }
  $('count').textContent = `${nodes.length} types · ${edges.length} links`;
}

function fit(): void {
  const { nodes } = visible();
  const bs = nodes.map((n) => boxes.get(n.id)).filter((b): b is Box => !!b);
  if (!bs.length) return;
  const minX = Math.min(...bs.map((b) => b.x - b.w / 2));
  const maxX = Math.max(...bs.map((b) => b.x + b.w / 2));
  const minY = Math.min(...bs.map((b) => b.y - b.h / 2)) - 50; // self-relation loops sit above their box
  const maxY = Math.max(...bs.map((b) => b.y + b.h / 2));
  const r = svg.getBoundingClientRect();
  const k = Math.min(1.4, (r.width - 60) / (maxX - minX || 1), (r.height - 60) / (maxY - minY || 1));
  view = { k, x: r.width / 2 - ((minX + maxX) / 2) * k, y: r.height / 2 - ((minY + maxY) / 2) * k };
  draw();
  persist();
}

// ---------------------------------------------------------------------------
// Interaction
// ---------------------------------------------------------------------------

function toGraph(ev: PointerEvent | WheelEvent | MouseEvent): [number, number] {
  const r = svg.getBoundingClientRect();
  return [(ev.clientX - r.left - view.x) / view.k, (ev.clientY - r.top - view.y) / view.k];
}

let drag: { id?: string; sx: number; sy: number; ox: number; oy: number; moved: boolean } | undefined;

svg.addEventListener('pointerdown', (ev) => {
  const g = (ev.target as Element).closest('g.node');
  const id = g?.getAttribute('data-id') ?? undefined;
  const b = id ? boxes.get(id) : undefined;
  drag = { id, sx: ev.clientX, sy: ev.clientY, ox: b ? b.x : view.x, oy: b ? b.y : view.y, moved: false };
  svg.setPointerCapture(ev.pointerId);
});
svg.addEventListener('pointermove', (ev) => {
  if (!drag) return;
  const dx = ev.clientX - drag.sx;
  const dy = ev.clientY - drag.sy;
  if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
  if (!drag.moved) return;
  const b = drag.id ? boxes.get(drag.id) : undefined;
  if (b) {
    b.x = drag.ox + dx / view.k;
    b.y = drag.oy + dy / view.k;
    b.pinned = true;
  } else {
    view.x = drag.ox + dx;
    view.y = drag.oy + dy;
  }
  draw();
});
svg.addEventListener('pointerup', () => {
  if (drag && !drag.moved) {
    selected = drag.id && drag.id !== selected ? drag.id : undefined;
    if (selected) vscode.postMessage({ type: 'reveal', uid: selected });
    draw();
  }
  if (drag?.moved) persist();
  drag = undefined;
});
svg.addEventListener('dblclick', (ev) => {
  const id = (ev.target as Element).closest('g.node')?.getAttribute('data-id');
  if (id) vscode.postMessage({ type: 'open', uid: id });
});
svg.addEventListener(
  'wheel',
  (ev) => {
    ev.preventDefault();
    const [gx, gy] = toGraph(ev);
    const k = Math.min(3, Math.max(0.15, view.k * Math.exp(-ev.deltaY * 0.0015)));
    const r = svg.getBoundingClientRect();
    view = { k, x: ev.clientX - r.left - gx * k, y: ev.clientY - r.top - gy * k };
    draw();
    persist();
  },
  { passive: false },
);

$('search').addEventListener('input', (ev) => {
  search = (ev.target as HTMLInputElement).value;
  draw();
});
$('search').addEventListener('keydown', (ev) => {
  if ((ev as KeyboardEvent).key !== 'Enter' || !search.trim()) return;
  const q = search.trim().toLowerCase();
  const n = visible().nodes.find((x) => x.label.toLowerCase().includes(q) || x.id.toLowerCase().includes(q));
  const b = n && boxes.get(n.id);
  if (!b) return;
  const r = svg.getBoundingClientRect();
  view = { ...view, x: r.width / 2 - b.x * view.k, y: r.height / 2 - b.y * view.k };
  selected = n.id;
  draw();
});
const toggle = (id: string, key: 'components' | 'allPlugins'): void => {
  const box = $<HTMLInputElement>(id);
  box.checked = saved[key];
  box.addEventListener('change', () => {
    saved[key] = box.checked;
    const v = visible();
    layout(v.nodes, v.edges, false);
    draw();
    persist();
  });
};
toggle('components', 'components');
toggle('allPlugins', 'allPlugins');
$('fit').addEventListener('click', fit);
$('relayout').addEventListener('click', () => {
  const v = visible();
  layout(v.nodes, v.edges, true);
  fit();
});
$('export').addEventListener('click', () => vscode.postMessage({ type: 'export', svg: exportSvg() }));
$<HTMLSelectElement>('project').addEventListener('change', (ev) => vscode.postMessage({ type: 'project', root: (ev.target as HTMLSelectElement).value }));
window.addEventListener('resize', () => draw());

/** A standalone SVG: the computed theme colours inlined, framed on the drawing. */
function exportSvg(): string {
  const clone = svg.cloneNode(true) as SVGSVGElement;
  const src = svg.querySelectorAll('*');
  const dst = clone.querySelectorAll('*');
  src.forEach((s, i) => {
    const cs = getComputedStyle(s);
    const d = dst[i] as SVGElement | undefined;
    if (!d) return;
    for (const p of ['fill', 'stroke', 'stroke-width', 'stroke-dasharray', 'opacity', 'font-size', 'font-family', 'font-weight']) d.setAttribute(p, cs.getPropertyValue(p));
  });
  const g = layer.getBBox();
  clone.setAttribute('xmlns', SVG);
  clone.setAttribute('viewBox', `${g.x * view.k + view.x - 20} ${g.y * view.k + view.y - 20} ${g.width * view.k + 40} ${g.height * view.k + 40}`);
  clone.setAttribute('style', `background:${getComputedStyle(document.body).backgroundColor}`);
  return new XMLSerializer().serializeToString(clone);
}

window.addEventListener('message', (ev: MessageEvent<ToWebview>) => {
  if (ev.data?.type !== 'data') return;
  const first = !data || data.root !== ev.data.data.root;
  data = ev.data.data;
  const select = $<HTMLSelectElement>('project');
  select.replaceChildren(...data.projects.map((p) => Object.assign(document.createElement('option'), { value: p.root, textContent: p.name, selected: p.root === data!.root })));
  select.style.display = data.projects.length > 1 ? '' : 'none';
  if (first) {
    boxes = new Map(Object.entries(saved.positions[data.root] ?? {}));
    view = saved.view[data.root] ?? view;
  }
  const v = visible();
  layout(v.nodes, v.edges, false);
  if (first && !saved.view[data.root]) fit();
  else draw();
  $('empty').classList.toggle('hidden', v.nodes.length > 0);
});

vscode.postMessage({ type: 'ready' });
