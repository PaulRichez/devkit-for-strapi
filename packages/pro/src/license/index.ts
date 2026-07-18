/**
 * License gating for the Pro engine — pure entitlement resolution
 * ({@link resolveLicense} / {@link isPro}) and the MCP "Pro required" upsell
 * ({@link proRequired}). The online verifier and the cache are seams the
 * clients (MCP server, VS Code extension) implement with real HTTP/disk.
 */

export {
  DEV_KEY,
  isPro,
  resolveLicense,
  type CachedLicense,
  type LicenseCache,
  type LicenseReason,
  type LicenseResult,
  type LicenseTier,
  type LicenseValidation,
  type LicenseVerifier,
  type ResolveLicenseParams,
} from './validate';

export { ACTIVATE_HINT, GET_PRO_URL, isProTool, proRequired, proToolNames, type ProUpsell } from './upsell';
