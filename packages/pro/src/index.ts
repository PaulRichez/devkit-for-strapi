/**
 * Public API of the Pro (write/refactor) engine — the position-keyed rename, the
 * ref-keyed planners (rename/move/scaffold/schema), the contractual plan
 * fingerprint/verify, and config-sync through the project's own Strapi (the runtime). Separate from the MIT `core` (rule #6); consumed by the MCP
 * server and the VS Code extension, gated behind a license at those boundaries.
 */

export { computeRename, planRename, prepareRename } from './rename/rename';
export {
  ABSENT,
  fingerprintEdit,
  hashString,
  planEdit,
  verifyFingerprints,
  type FileFingerprint,
  type PlannedEdit,
  type VerifyResult,
} from './edit/plan';
export { planMove, type MoveOptions, type MovePlan, type MoveSpec } from './edit/move';
export { planCreatePlugin, type ScaffoldPlan } from './edit/scaffold';
export { planChangeRelation, planRenameAttribute, type SchemaEditPlan } from './edit/schema';
export {
  configSyncDiff,
  configSyncExport,
  configSyncImport,
  type ConfigSyncDbEntry,
  type ConfigSyncDbState,
  type ConfigSyncDiffData,
  type ConfigSyncWriteData,
  type ConfigSyncWriteOptions,
} from './config-sync/runtime';
export type { DatabaseTarget, RuntimeErrorKind, RuntimeFailure, RuntimeOptions, RuntimeResult, RuntimeStep, RuntimeSuccess, RuntimeTimings } from './runtime/types';
export { runtimeHint } from './runtime/hints';
export * from './license';
