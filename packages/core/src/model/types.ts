/** Data model for an indexed Strapi project. Plain data — no behaviour, no IO. */

export type StrapiVersion = 4 | 5;

export interface VersionSignals {
  /** Major version parsed from `@strapi/strapi` in package.json, if any. */
  packageMajor?: number;
  /** The raw semver spec, for diagnostics/debugging. */
  spec?: string;
}

export interface AttributeInfo {
  name: string;
  type: string;
  /** Relation target UID, e.g. `api::category.category`. */
  target?: string;
  /** Component UID for `type: 'component'`, e.g. `shared.seo`. */
  component?: string;
  /** Component UIDs for a dynamic zone (`type: 'dynamiczone'`). */
  components?: string[];
  /** Char offset of the attribute key inside the schema/component JSON. */
  keyOffset: number;
}

export type ContentTypeSource = 'api' | 'plugin';

export interface ContentType {
  /** `api::<api>.<ct>` or `plugin::<plugin>.<ct>`. */
  uid: string;
  kind: 'collectionType' | 'singleType';
  /** API name (or plugin name when `source === 'plugin'`). */
  apiName: string;
  ctName: string;
  schemaPath: string;
  source: ContentTypeSource;
  pluginName?: string;
  info: { singularName?: string; pluralName?: string; displayName?: string };
  attributes: Record<string, AttributeInfo>;
  /** Char offset to anchor UI (e.g. a CodeLens) on, near the definition. */
  defOffset?: number;
  /**
   * True when the schema comes from `src/extensions/<plugin>/content-types/…` —
   * a *merge overlay* Strapi applies over the plugin's original schema (which
   * lives in node_modules, unindexed). The attributes listed are the extension's
   * own — a partial view of the runtime schema, honestly flagged.
   */
  extension?: boolean;
}

export interface ComponentDef {
  /** `<category>.<name>`. */
  uid: string;
  category: string;
  name: string;
  jsonPath: string;
  info: { displayName?: string };
  attributes: Record<string, AttributeInfo>;
  defOffset?: number;
}

export type ArtifactKind = 'service' | 'controller' | 'policy' | 'middleware';
export type ArtifactScope = 'api' | 'global' | 'plugin';

export interface ControllerAction {
  name: string;
  offset: number;
  /** The method header as written (e.g. `async notify(message: string)`), if any. */
  signature?: string;
}

export interface CodeArtifact {
  /** Canonical reference: `api::<api>.<name>`, `plugin::<plugin>.<name>`, or `global::<name>`. */
  ref: string;
  kind: ArtifactKind;
  filePath: string;
  scope: ArtifactScope;
  /** File base name without extension. */
  name: string;
  apiName?: string;
  pluginName?: string;
  /** Controllers only: exported action methods with their offsets. */
  actions?: ControllerAction[];
  /** True when the factory object spreads (`...shared`) → the action list is partial. */
  hasSpread?: boolean;
  /** Char offset of the definition (factory call / export), for UI anchoring. */
  defOffset?: number;
}

export interface StrapiIndex {
  /** keyed by UID */
  contentTypes: Map<string, ContentType>;
  /** keyed by `<category>.<name>` */
  components: Map<string, ComponentDef>;
  /** keyed by canonical ref */
  services: Map<string, CodeArtifact>;
  controllers: Map<string, CodeArtifact>;
  policies: Map<string, CodeArtifact>;
  middlewares: Map<string, CodeArtifact>;
  /** local plugin names discovered under `src/plugins` */
  pluginNames: Set<string>;
  /**
   * Reverse map: normalized filePath → the definition entries it contributes.
   * Lets {@link updateIndexForFile} remove a file's old definitions without
   * re-walking every map (incremental definition index — O(1) removal).
   */
  fileDefs: Map<string, FileDefEntry[]>;
}

/** One entry in the reverse index: which map and which key a file contributes. */
export interface FileDefEntry {
  map: 'contentTypes' | 'components' | 'services' | 'controllers' | 'policies' | 'middlewares';
  key: string;
}

export interface StrapiProject {
  /** Directory containing package.json (forward-slash, absolute). */
  root: string;
  srcDir: string;
  version: StrapiVersion;
  versionSignals: VersionSignals;
  /** Exact installed Strapi version (from `node_modules/@strapi/strapi`), when resolvable. */
  strapiVersion?: string;
  index: StrapiIndex;
  /** Reverse index: canonical target key → every call-site that references it. */
  references: Map<string, ReferenceLocation[]>;
}

export function emptyIndex(): StrapiIndex {
  return {
    contentTypes: new Map(),
    components: new Map(),
    services: new Map(),
    controllers: new Map(),
    policies: new Map(),
    middlewares: new Map(),
    pluginNames: new Set(),
    fileDefs: new Map(),
  };
}

// ---------------------------------------------------------------------------
// Public engine I/O types (editor-agnostic; the client maps these to vscode.*)
// ---------------------------------------------------------------------------

export type ReferenceKind =
  | 'content-type-uid' // documents()/entityService/db.query/factory → schema.json
  | 'service-ref'
  | 'controller-ref'
  | 'controller-action' // route handler 'api::x.x.find' → controller method
  | 'policy-ref'
  | 'middleware-ref'
  | 'component-uid'
  | 'plugin-name'
  | 'plugin-service-ref';

export type ApiStyle =
  | 'entityService'
  | 'db.query'
  | 'query' // strapi.query('uid') — the v4 bare form (no `.db`)
  | 'documents'
  | 'service'
  | 'controller'
  | 'contentType' // strapi.contentType('uid')
  | 'getModel' // strapi.getModel('uid')
  | 'factory'
  | 'route'
  | 'plugin'
  | 'schema'
  | 'config';

/** What kind of magic string the cursor sits in, and where. */
export interface ReferenceContext {
  kind: ReferenceKind;
  /** The string contents (without surrounding quotes). */
  text: string;
  /** Offsets of the string contents (inside the quotes) in the source. */
  range: { start: number; end: number };
  /** For `plugin-service-ref`: the plugin name from `.plugin('a')`, if literal. */
  pluginName?: string;
  apiStyle?: ApiStyle;
  /** false for template/variable/concatenation → no completion, no navigation. */
  isLiteral: boolean;
}

export interface TargetLocation {
  filePath: string;
  /** Char offset of the anchor within the file (defaults to 0). */
  offset?: number;
  length?: number;
}

export interface CompletionEntry {
  label: string;
  insertText?: string;
  detail?: string;
  documentation?: string;
  kind?: 'value' | 'reference' | 'method' | 'class' | 'module';
}

export interface CompletionResult {
  /** Range of the string contents to replace when an item is accepted. */
  replace?: { start: number; end: number };
  items: CompletionEntry[];
}

export interface HoverInfo {
  /** Markdown shown on hover over a recognized magic string. */
  markdown: string;
  /** Range of the string contents the hover applies to. */
  range?: { start: number; end: number };
}

export interface Position {
  line: number;
  character: number;
}

export interface ReferenceLocation {
  filePath: string;
  /** Line/character of the string contents that references the target. */
  start: Position;
  end: Position;
  /**
   * How this reference reaches the target — `'schema'` (relation/component link
   * in JSON), `'route'` (route handler), `'member'` (method call), or an
   * `ApiStyle` value for code call-sites. Drives the insights breakdown.
   */
  via?: string;
  /** The trimmed source line the reference sits on (so callers needn't re-read the file). */
  snippet?: string;
}

export interface CodeLensEntry {
  /** Char offset in the file where the "N references" lens is anchored. */
  offset: number;
  count: number;
  /** True for a per-method lens (vs a file/entity-level one), so clients can filter. */
  method: boolean;
  /** Distinguishes the kind of lens so clients can title it differently. */
  kind?: 'references' | 'incoming-relations';
  /** The references the lens points to (so the client can peek them directly). */
  references: ReferenceLocation[];
}

/** Per-content-type usage insights (counts + who targets it), editor-agnostic. */
export interface ContentTypeInsights {
  total: number;
  /** Content-types that declare a relation `target` pointing at this one. */
  incomingRelations: { fromUid: string; filePath: string; line: number }[];
  routeHandlers: number;
  dataUsages: number;
}

export interface ComponentInsights {
  /** UIDs of content-types (or components) that use this component. */
  usedInContentTypes: string[];
  usedByCount: number;
}

/** A relation attribute of a content-type, for the model tree. */
export interface OutlineRelation {
  attr: string;
  targetUid: string;
  offset: number;
}

/** A component usage (single or dynamic-zone entry) of a content-type. */
export interface OutlineComponentUse {
  attr: string;
  uid: string;
  offset: number;
}

export interface OutlineContentType {
  uid: string;
  displayName: string;
  kind: 'collectionType' | 'singleType';
  schemaPath: string;
  defOffset: number;
  refCount: number;
  routeHandlers: number;
  dataUsages: number;
  incomingRelations: { fromUid: string; filePath: string; line: number }[];
  relations: OutlineRelation[];
  components: OutlineComponentUse[];
}

export interface OutlineComponent {
  uid: string;
  jsonPath: string;
  defOffset: number;
  usedByCount: number;
}

export interface OutlineIssue {
  kind: 'unused-content-type' | 'orphan-component';
  uid: string;
  label: string;
}

/** The whole model of one Strapi project, for the Model Explorer tree. */
export interface OutlineProject {
  root: string;
  version: StrapiVersion;
  contentTypes: OutlineContentType[];
  components: OutlineComponent[];
  issues: OutlineIssue[];
}

export interface RenamePrepare {
  /** Char offsets in the source file of the segment that will be renamed. */
  start: number;
  end: number;
  /** Current name (shown in the rename input box). */
  placeholder: string;
  /**
   * Whether this position is DevKit's to rename *exclusively* — a magic string
   * or an `any`-typed member call (`strapi.service('x').method()`) that the
   * editor's native (TS) rename can't touch. When `false`, the position is a
   * real TS symbol too (a method *declaration*): the client must step aside so
   * the native rename still works for free users instead of being blocked.
   */
  exclusive: boolean;
}

export interface TextEditOp {
  filePath: string;
  start: Position;
  end: Position;
  newText: string;
}

export interface FileRenameOp {
  from: string;
  to: string;
}

export interface FileCreateOp {
  path: string;
  content: string;
}

/**
 * A batch of file edits a planner produces and a single executor applies
 * (LSP-shaped: text edits + file creates/renames/deletes). Every refactoring —
 * rename, move, extract, scaffold — returns this one shape.
 */
export interface WorkspaceEdit {
  textEdits: TextEditOp[];
  /** File/folder renames (the ref is derived from the file/folder name). */
  fileRenames: FileRenameOp[];
  /** Files to create (move/extract/scaffold). */
  fileCreates?: FileCreateOp[];
  /** Paths to delete. */
  fileDeletes?: string[];
}

/** @deprecated Alias of {@link WorkspaceEdit}, kept for existing rename call-sites. */
export type RenameEdit = WorkspaceEdit;

export type DiagnosticSeverity = 'error' | 'warning' | 'info';

export interface DiagnosticQuickFix {
  title: string;
  /** Replacement text for the diagnostic range. */
  replacement: string;
}

export interface DiagnosticEntry {
  message: string;
  start: number;
  end: number;
  severity: DiagnosticSeverity;
  code: string;
  quickFixes?: DiagnosticQuickFix[];
}

export interface ProjectSummary {
  root: string;
  /** Major version (drives engine logic: v4-in-v5, auto-CRUD, call forms). */
  version: StrapiVersion;
  /** Exact installed Strapi version (`node_modules/@strapi/strapi`), when resolvable. */
  strapiVersion?: string;
  /** The `@strapi/strapi` range declared in package.json (e.g. `^4.25.1`). */
  declaredVersion?: string;
  counts: {
    contentTypes: number;
    components: number;
    services: number;
    controllers: number;
    policies: number;
    middlewares: number;
  };
}

/** One HTTP route, parsed statically from a `routes/*` file. */
export interface RouteInfo {
  method: string;
  path: string;
  /** Route handler ref, e.g. `api::product.product.find`. */
  handler: string;
  policies?: string[];
  middlewares?: string[];
  /** `router-file` = explicit route; `core-router` = synthesized from `createCoreRouter`. */
  source: 'router-file' | 'core-router';
}
