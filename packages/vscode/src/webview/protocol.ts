/** Messages between the extension and the relations diagram webview (no DOM, no vscode: shared by both). */

import type { DiagramData, DiagramOptions } from 'devkit-for-strapi-core/diagram';

export type { DiagramAttr, DiagramData, DiagramEdge, DiagramLink, DiagramNode, DiagramOptions } from 'devkit-for-strapi-core/diagram';

export type ToWebview = { type: 'data'; data: DiagramData } | { type: 'render'; format: 'svg' | 'png' };

export type FromWebview =
  | { type: 'ready' }
  | { type: 'reveal'; uid: string }
  | { type: 'open'; uid: string }
  | { type: 'project'; root: string }
  /** "Export…": the extension asks for the format; the options are what the view shows. */
  | { type: 'exportMenu'; options: DiagramOptions }
  /** The rendered drawing: SVG text, or PNG as base64. */
  | { type: 'export'; format: 'svg' | 'png'; data: string };
