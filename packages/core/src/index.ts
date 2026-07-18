/** Public API of the editor-agnostic Strapi engine. */

export { createEngine, type StrapiEngine } from './engine';

// File system seam
export { type DirEntry, FileType, type FileSystem } from './fs/FileSystem';
export { MemoryFileSystem } from './fs/MemoryFileSystem';
export * as paths from './fs/paths';

// Data model & I/O types
export * from './model/types';
export * from './model/uid';

// Building blocks (used by the client, tests, and a future LSP server)
export { buildIndex, updateIndexForFile } from './index/indexer';
export { listRoutes } from './index/routes';
export { parseSchemaFile } from './index/schema';
export { parseComponentFile } from './index/components';
export { extractControllerActions } from './index/actions';
export { discoverProjectRoots, isStrapiPackageJson } from './workspace/discovery';
export { detectVersion, parseMajor } from './workspace/version';
export { analyzeAt, collectReferences } from './analyze/callSite';
export { analyzeMemberAt, type MemberAccessRef } from './analyze/member';
export { collectMemberReferences, collectThisMemberReferences } from './analyze/memberRefs';
export { pluginNameOf } from './analyze/patterns';
export { parseSource } from './analyze/parse';
export { analyzeApiMemberAt, type ApiMemberRef } from './analyze/apiMember';
export { analyzeMemberCompletionAt, type MemberCompletion } from './analyze/memberCompletion';
export { extractMethods, factoryObjectRange } from './index/actions';
export { lineStarts, positionAt } from './util/lines';
export { STRAPI_APIS, type StrapiApiId } from './model/strapiApi';
export { resolveDefinition, resolveMember } from './resolve/resolver';
export { owningApiName, owningPluginName, qualifyRouteHandler } from './resolve/owner';
export { describeHover, describeMemberHover, describeApiMemberHover } from './hover/hover';
export {
  buildReferenceIndex,
  canonicalKey,
  definitionsInFile,
  type DefinitionAnchor,
  removeReferencesForFile,
  scopedKey,
  updateReferencesForFile,
} from './reference/references';
export {
  buildModelMaps,
  componentInsights,
  contentTypeInsights,
  type ModelMaps,
} from './reference/insights';
export { pathsOutsideRoots, touchedPaths } from './edit/plan';
export { DiagnosticCode, validateDocument } from './validate/validator';
export { complete } from './complete/completion';

// Ref-keyed query API (UID/magic-string → schema/targets/refs/validity) for the
// MCP server and any future LSP — the position-free counterpart of the engine.
export {
  callFormCoverage,
  getSchema,
  listArtifacts,
  listBrokenRefs,
  listComponents,
  listContentTypes,
  listUnused,
  referencesOf,
  relationUsagesOf,
  resolveRef,
  validateRef,
  type ArtifactSummary,
  type BrokenRef,
  type CallFormCoverage,
  type RelationFieldUsage,
  type ComponentSummary,
  type ContentTypeSummary,
  type ResolvedTarget,
  type SchemaAttribute,
  type SchemaInfo,
  type TargetKind,
  type UnusedItem,
  type UnusedKind,
  type ValidationResult,
  type ValidationStatus,
} from './query/refQuery';
export {
  selectProject,
  type ProjectCandidate,
  type ProjectSelection,
  type ProjectSelector,
} from './query/select';
export { dependencies, dependents, listRefs, type GraphOptions, type RefSummary } from './query/graph';
