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
  /** Relation kind (`oneToOne`, `manyToOne`, `morphToMany`, …). */
  relation?: string;
  /** The other side of a bidirectional relation. */
  mappedBy?: string;
  inversedBy?: string;
  /** A repeatable component. */
  repeatable?: boolean;
  /** A media field holding several files. */
  multiple?: boolean;
  required?: boolean;
  unique?: boolean;
  /** Not returned by the API. */
  private?: boolean;
  /** `visible: false`: left out of the admin (the content-manager has no field for it). */
  hidden?: boolean;
  /** An enumeration's values. */
  enum?: string[];
  /** A `customField`'s registered name (`plugin::color-picker.color`). */
  customField?: string;
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
  /** The database table (`collectionName`), when declared. */
  collectionName?: string;
  /** `options.draftAndPublish === true`. */
  draftAndPublish?: boolean;
  /** `pluginOptions['content-manager'].visible === false`: not shown (nor permissioned) in the content-manager. */
  contentManagerHidden?: boolean;
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
  /**
   * True when read from an **installed** plugin in `node_modules` (not the
   * user's code): never a refactor target, never "unused", hidden from the model
   * outline. Its locations point into `node_modules`.
   */
  installed?: boolean;
  /** True when the schema's attributes could not be read exhaustively (the UID itself is certain). */
  partialAttributes?: boolean;
  /** `pluginOptions.i18n.localized === true` (drives Strapi 4 i18n's injected localization route). */
  i18nLocalized?: boolean;
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
  /**
   * File holding the method when it is not the artifact's own file (an installed
   * plugin's compiled object can spread methods from another module). `offset`
   * is relative to this file when set.
   */
  filePath?: string;
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
  /** True when read from an installed plugin in `node_modules` (see {@link ContentType.installed}). */
  installed?: boolean;
  /**
   * True when the name is inferred from the folder convention because the local
   * plugin's registry could not be read (an object built by a helper, a loader
   * DevKit doesn't recognise): Strapi may register the file under another name,
   * or not at all — so it is never reported unused.
   */
  unconfirmed?: boolean;
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
   * Installed (`node_modules`) plugins read exhaustively: refs into them are
   * verifiable exactly like local ones (see `plugins/installed.ts`).
   */
  verifiedPlugins?: Set<string>;
  /** Every enabled installed plugin (complete or not), for plugin-name completion/hover. */
  installedPlugins?: Map<string, { packageName: string; version?: string; complete: boolean }>;
  /**
   * Local-plugin content-types declared **in code** (`content-types/index.ts`
   * holding the schema object) rather than in a `<ct>/schema.json` folder. Kept
   * OUT of {@link contentTypes} on purpose: refactors derive the content-type
   * folder from `schemaPath`, which here is a shared code file. Read paths
   * (validation, resolve, hover, completion) consult both.
   */
  codeContentTypes?: Map<string, ContentType>;
  /** Local plugins whose content-type list could not be read exhaustively (refs into them stay silent). */
  partialContentTypePlugins?: Set<string>;
  /**
   * Local plugins whose services/controllers/policies/middlewares registry could
   * not be read exhaustively, by kind (see `plugins/localRegistry.ts`): a ref to a
   * name DevKit doesn't see there is unverifiable — never reported unknown/broken.
   */
  openCollections?: Map<string, Set<ArtifactKind>>;
  /**
   * Where the code DevKit couldn't read builds each open collection, keyed
   * `<plugin>/<kind>` (the object with a helper spread into it, the loader call) —
   * said by `project_info` and `validate_reference`, so a partial check is never silent.
   */
  openCollectionSites?: Map<string, { file: string; pos: number; line?: number }>;
  /**
   * Strapi's built-in middlewares (`strapi::<name>` → definition), present only
   * when read exhaustively from the installed Strapi — then `strapi::` names in
   * `config/middlewares` are verified instead of skipped.
   */
  frameworkMiddlewares?: Map<string, { filePath: string; offset: number }>;
  /** Plugins (or `'*'`) some code rewrites at runtime: never verified, local ones included. */
  rewrittenPlugins?: Set<string>;
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
  /**
   * Per file, the UIDs written as plain values (a registry map, a config entry):
   * their weak references are keyed from these by the index as it is now
   * (`reference/references.ts#resyncWeakLiterals`).
   */
  weakLiterals?: Map<string, import('../reference/references').WeakLiteral[]>;
  /** Installed plugins read from `node_modules` (absent when Strapi isn't installed). */
  installed?: import('../plugins/installed').InstalledPluginsResult;
  /** Freshness fingerprint of {@link installed} (see `plugins/merge.ts#installedStamp`). */
  installedStamp?: string;
  /** The full (every parsed plugin file) fingerprint, checked less often. */
  installedFullStamp?: string;
  /** What the project's own code rewrites in plugins at runtime (kept per file, updated on edits). */
  rewrites?: import('../plugins/rewrites').ProjectRewrites;
  /** When the project code was indexed (ms epoch). */
  indexedAt?: number;
  /** When its installed plugins were last read, and how many of them came from the read cache. */
  installedAt?: number;
  pluginReads?: { read: number; reused: number };
  /** The project's files and mtimes, for clients without a file watcher (see `refreshIfStale`). */
  snapshot?: import('../workspace/sourceSnapshot').SourceSnapshot;
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
  /**
   * The string initialises a `const` the code passes to a Strapi call
   * (`const X = 'api::x.y'; strapi.db.query(X)`): validated, renamed and moved
   * here, its references counted at the call sites.
   */
  constant?: boolean;
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
  /**
   * In a subfolder of `database/migrations`, which Strapi never runs (it runs the
   * files at its root only): listed, but it doesn't make its target used.
   */
  archived?: boolean;
  /**
   * The reference is a shorthand property key (`filters: { user }`): its token is
   * also a variable's name, so a rename must keep the value (`owner: user`).
   */
  shorthand?: boolean;
  /**
   * A call whose UID DevKit can't read (`unresolved:` keys): the start every UID
   * it may reach has — `plugin::y.` for `strapi.plugin('y').service(name)`.
   * Absent when none is readable (it may reach anything of its kind).
   */
  scope?: string;
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
  /** What the plan leaves undone or can't do, said before it is applied. */
  warnings?: string[];
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
  /** Set when the project's Strapi is newer than DevKit knows (Strapi 6…): what that means. */
  unsupportedVersion?: string;
  counts: {
    contentTypes: number;
    components: number;
    services: number;
    controllers: number;
    policies: number;
    middlewares: number;
  };
  /** How current the answers are. */
  freshness: {
    /** The project code was last indexed in full (ISO). */
    indexedAt?: string;
    /** Files last compared with the disk, changes re-indexed (ISO; clients without a watcher). */
    diskCheckedAt?: string;
    /** Clients without a watcher: `off` when the project is too large to compare (call refresh after external edits). */
    diskTracking?: 'on' | 'off';
    /** Installed plugins last read (ISO); `pluginsLoading` while the first read runs. */
    pluginsReadAt?: string;
    pluginsLoading?: boolean;
    /** Plugins read from node_modules on that read vs reused unchanged from the read cache. */
    pluginReads?: { read: number; fromCache: number };
  };
}

/**
 * A route's `config.auth` when it isn't the default: `public` (`auth: false` — Strapi
 * skips authenticate and authorize), `custom` (an object: Strapi uses its `strategies`
 * and checks its `scope`), `unread` (not a literal). Absent: the route type's default
 * strategies, then the permissions of the role or token (set in the admin).
 */
export type RouteAuth = { mode: 'public' } | { mode: 'custom'; scope?: string[]; strategies?: string[] } | { mode: 'unread' };

/** A policy/middleware entry declared as a function (no name to resolve). */
export const INLINE_ENTRY = '<inline>';
/** A policy/middleware list or entry that could not be read statically. */
export const UNREAD_ENTRY = '<unread>';

/** One HTTP route, parsed statically (project route files, local and installed plugins). */
export interface RouteInfo {
  method: string;
  /** Path as declared (router-relative, without the API prefix). */
  path: string;
  /** Route handler ref, e.g. `api::product.product.find` (`<inline>` for a function handler). */
  handler: string;
  /** In declaration order; {@link INLINE_ENTRY} for a function, {@link UNREAD_ENTRY} when not read statically. */
  policies?: string[];
  /** Same as {@link policies}. */
  middlewares?: string[];
  /** `config.auth` when it isn't the default (see {@link RouteAuth}). */
  auth?: RouteAuth;
  /**
   * `router-file` = explicit route; `core-router` = synthesized from `createCoreRouter`;
   * `plugin` = declared by a plugin's server; `plugin-injected` = added to an API by a
   * plugin at boot (Strapi 4 i18n's `/:id/localizations`).
   */
  source: 'router-file' | 'core-router' | 'plugin' | 'plugin-injected';
  /** Where the route is declared (route object, `createCoreRouter` call, plugin route). */
  filePath?: string;
  offset?: number;
  /** Mounted path, API prefix included (`/api/articles/:id`); absent when the prefix isn't literal. */
  fullPath?: string;
  /** `content-api` (public API) or `admin` (admin panel). */
  type?: 'content-api' | 'admin';
  /** `api::<api>` or `plugin::<name>`. */
  owner?: string;
  origin?: 'project' | 'local-plugin' | 'installed-plugin';
  /** `config.auth === false` — reachable without authentication. */
  public?: boolean;
}
