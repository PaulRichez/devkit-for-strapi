/** Messages between the extension and the relations diagram webview (no DOM, no vscode: shared by both). */

export interface DiagramNode {
  /** The UID. */
  id: string;
  label: string;
  kind: 'collectionType' | 'singleType' | 'component';
  /** `api`, `local-plugin`, `installed-plugin`, `component`. */
  origin: string;
  fields: number;
}

export interface DiagramEdge {
  from: string;
  to: string;
  /** The field. */
  label: string;
  kind: 'relation' | 'component';
  /** The relation kind (`manyToOne`, …). */
  relation?: string;
}

export interface DiagramData {
  root: string;
  project: string;
  projects: Array<{ root: string; name: string }>;
  nodes: DiagramNode[];
  edges: DiagramEdge[];
}

export type ToWebview = { type: 'data'; data: DiagramData };

export type FromWebview =
  | { type: 'ready' }
  | { type: 'reveal'; uid: string }
  | { type: 'open'; uid: string }
  | { type: 'project'; root: string }
  | { type: 'export'; svg: string };
