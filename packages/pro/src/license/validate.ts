/**
 * License resolution — the pure decision logic behind `isPro`. Given a key, an
 * (injected) online verifier and an optional persistent cache, it decides the
 * tier with the "validate once on activation, then trust the cache offline"
 * policy. Pure (rule #4 mirror): the real HTTP call to Polar and the on-disk
 * cache live at the client boundary (the MCP server / the VS Code extension)
 * behind the {@link LicenseVerifier} / {@link LicenseCache} seams, so this is
 * fully testable without network or disk. Never throws — a verifier failure
 * degrades to the cache (then `free`) so a network blip can't lock out a paid,
 * already-activated user.
 */

import { hashString } from '../edit/plan';

/** A resolved entitlement. */
export type LicenseTier = 'pro' | 'free';

/** Why a tier was granted/denied — for diagnostics/logs, never user-facing. */
export type LicenseReason =
  | 'no-key' //          no key supplied → free
  | 'dev-override' //    DEVKIT_LICENSE_KEY=dev in a dev build → pro
  | 'valid' //           verified online just now → pro
  | 'cached' //          a recent online verification reused (within TTL) → pro
  | 'cached-offline' //  verifier unreachable, a valid cache within grace → pro
  | 'invalid' //         verifier says the key is unknown/inactive → free
  | 'expired' //         key valid but past its expiry → free
  | 'unverified'; //     verifier unreachable and no usable cache → free

/** The outcome of {@link resolveLicense}. */
export interface LicenseResult {
  tier: LicenseTier;
  reason: LicenseReason;
  /** Wall-clock (ms) the decision was made. */
  checkedAt: number;
  /** Key expiry (ms) when known, `null` for a perpetual key. */
  expiresAt: number | null;
}

/** What an online verifier (Polar) reports for a key. */
export interface LicenseValidation {
  valid: boolean;
  /** Expiry in ms, or `null`/absent for a perpetual key. */
  expiresAt?: number | null;
}

/** Online check of a key — implemented at the client boundary (HTTP to Polar). */
export interface LicenseVerifier {
  validate(key: string): Promise<LicenseValidation>;
}

/** A persisted validation, so a verified key keeps working offline. */
export interface CachedLicense {
  /** Hash of the key this entry is for (never the raw key). */
  keyHash: string;
  valid: boolean;
  /** When the online check happened (ms). */
  checkedAt: number;
  expiresAt: number | null;
}

/** Read/write the persisted validation — implemented with disk at the boundary. */
export interface LicenseCache {
  read(): CachedLicense | undefined;
  write(entry: CachedLicense): void;
}

/** Inputs to {@link resolveLicense} (time + flags injected for determinism). */
export interface ResolveLicenseParams {
  /** The license key (from env `DEVKIT_LICENSE_KEY` or the editor's secret store). */
  key: string | undefined;
  verifier: LicenseVerifier;
  cache?: LicenseCache;
  /** Current time (ms) — injected so the logic is deterministic in tests. */
  now: number;
  /** Honour the `dev` override key — true only in dev builds, never in production. */
  devMode?: boolean;
  /** How long an online verification is trusted before re-checking (default 7d). */
  cacheTtlMs?: number;
  /** How long a cached valid key keeps Pro while the verifier is unreachable (default 30d). */
  offlineGraceMs?: number;
}

const DAY = 24 * 60 * 60 * 1000;
const DEFAULT_TTL = 7 * DAY;
const DEFAULT_GRACE = 30 * DAY;

/** The one accepted dev-override key (honoured only when `devMode` is set). */
export const DEV_KEY = 'dev';

const notExpired = (expiresAt: number | null, now: number): boolean => expiresAt == null || expiresAt > now;

/**
 * Resolve the license tier: dev override → fresh cache → online verify → offline
 * grace. The cache is keyed by a hash of the key, so swapping keys never reuses a
 * stale entitlement.
 */
export async function resolveLicense(params: ResolveLicenseParams): Promise<LicenseResult> {
  const { key, verifier, cache, now, devMode = false } = params;
  const ttl = params.cacheTtlMs ?? DEFAULT_TTL;
  const grace = params.offlineGraceMs ?? DEFAULT_GRACE;

  if (!key) return { tier: 'free', reason: 'no-key', checkedAt: now, expiresAt: null };

  if (devMode && key === DEV_KEY) {
    return { tier: 'pro', reason: 'dev-override', checkedAt: now, expiresAt: null };
  }

  const keyHash = hashString(key);
  const cached = cache?.read();
  const cachedForKey = cached && cached.keyHash === keyHash ? cached : undefined;

  // Fresh cache → trust it without a network round-trip.
  if (cachedForKey && cachedForKey.valid && now - cachedForKey.checkedAt < ttl && notExpired(cachedForKey.expiresAt, now)) {
    return { tier: 'pro', reason: 'cached', checkedAt: cachedForKey.checkedAt, expiresAt: cachedForKey.expiresAt };
  }

  try {
    const res = await verifier.validate(key);
    const expiresAt = res.expiresAt ?? null;
    cache?.write({ keyHash, valid: res.valid, checkedAt: now, expiresAt });
    if (res.valid && notExpired(expiresAt, now)) {
      return { tier: 'pro', reason: 'valid', checkedAt: now, expiresAt };
    }
    return { tier: 'free', reason: res.valid ? 'expired' : 'invalid', checkedAt: now, expiresAt };
  } catch {
    // Verifier unreachable → fall back to a still-valid cache within the grace window.
    if (cachedForKey && cachedForKey.valid && now - cachedForKey.checkedAt < grace && notExpired(cachedForKey.expiresAt, now)) {
      return { tier: 'pro', reason: 'cached-offline', checkedAt: cachedForKey.checkedAt, expiresAt: cachedForKey.expiresAt };
    }
    return { tier: 'free', reason: 'unverified', checkedAt: now, expiresAt: null };
  }
}

/** Convenience predicate: is this entitlement Pro? */
export function isPro(result: LicenseResult): boolean {
  return result.tier === 'pro';
}
