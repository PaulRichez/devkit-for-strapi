import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  isPro,
  resolveLicense,
  type CachedLicense,
  type LicenseCache,
  type LicenseValidation,
  type LicenseVerifier,
} from 'devkit-for-strapi-pro';

/**
 * Node-side implementations of the Pro license seams (HTTP verifier + disk
 * cache) and the server's `isLicensed()` check. The pure decision logic lives
 * in `devkit-for-strapi-pro`; this file is the boundary that actually talks to
 * Polar and the filesystem (mirroring how `apply.ts` is the only write seam).
 */

/** Polar API base for license-key validation. */
const POLAR_API = 'https://api.polar.sh';

/**
 * Our Polar organization id — public (identifies the seller org, not a secret),
 * so it ships baked in. Overridable via `DEVKIT_POLAR_ORG_ID` for a sandbox org.
 */
const POLAR_ORG_ID = '6bb206eb-2492-4be2-b074-292f5468faa9';

/**
 * Online verifier backed by Polar's license-key validation endpoint. A 4xx is a
 * definite "no" (`valid:false`); a 5xx/transient error throws so
 * {@link resolveLicense} falls back to the offline cache instead of locking out
 * a paid user on a blip. Without an org id every key is invalid (locked default).
 *
 * Response shape confirmed against Polar's live API: a 200 carries
 * `status: granted|revoked|disabled` (+ optional `expires_at`); a 404 means the
 * key isn't found for this org. Only `granted` (and unexpired) counts as Pro.
 */
export function polarVerifier(organizationId: string | undefined, fetchImpl: typeof fetch = fetch): LicenseVerifier {
  return {
    async validate(key: string): Promise<LicenseValidation> {
      if (!organizationId) return { valid: false };
      const res = await fetchImpl(`${POLAR_API}/v1/customer-portal/license-keys/validate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key, organization_id: organizationId }),
      });
      if (res.status >= 400 && res.status < 500) return { valid: false }; // unknown/inactive key
      if (!res.ok) throw new Error(`Polar validate failed: ${res.status}`); // transient → offline fallback
      const body = (await res.json()) as { status?: string; expires_at?: string | null };
      const ms = body.expires_at ? Date.parse(body.expires_at) : NaN;
      return { valid: body.status === 'granted', expiresAt: Number.isNaN(ms) ? null : ms };
    },
  };
}

/** Disk-backed license cache (one small JSON file) — so a verified key works offline. */
export function fileCache(path: string): LicenseCache {
  return {
    read(): CachedLicense | undefined {
      try {
        if (!existsSync(path)) return undefined;
        return JSON.parse(readFileSync(path, 'utf8')) as CachedLicense;
      } catch {
        return undefined;
      }
    },
    write(entry: CachedLicense): void {
      try {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, JSON.stringify(entry), 'utf8');
      } catch {
        // best-effort: a read-only home just means we re-verify online next time
      }
    },
  };
}

/** Cache location — overridable via `DEVKIT_LICENSE_CACHE` (tests, custom homes). */
function cacheFile(): string {
  return process.env.DEVKIT_LICENSE_CACHE || join(homedir(), '.devkit-for-strapi', 'license.json');
}

/**
 * The server-side Pro check: read `DEVKIT_LICENSE_KEY` (the extension forwards
 * it into the spawn's env; a standalone client sets it in its MCP config),
 * validate it against Polar (cached offline), and return whether Pro is
 * unlocked. A positive result is memoized for the session; a negative one is
 * re-checked next call so a transient offline — or a key added mid-session —
 * isn't sticky.
 *
 * `DEVKIT_DEV=1` enables the `dev` override key, to dogfood the gate without
 * Polar. ⚠️ Dev-only backdoor — harden it out of the published bundle before
 * commercial launch (e.g. an esbuild `define` that neutralizes the env read).
 */
export function createLicenseCheck(): () => Promise<boolean> {
  let pending: Promise<boolean> | undefined;
  const resolveOnce = async (): Promise<boolean> => {
    const result = await resolveLicense({
      key: process.env.DEVKIT_LICENSE_KEY,
      verifier: polarVerifier(process.env.DEVKIT_POLAR_ORG_ID || POLAR_ORG_ID || undefined),
      cache: fileCache(cacheFile()),
      now: Date.now(),
      devMode: process.env.DEVKIT_DEV === '1',
    });
    return isPro(result);
  };
  return () => {
    if (!pending) {
      pending = resolveOnce().then((pro) => {
        if (!pro) pending = undefined; // not sticky: retry next call (transient offline / late key)
        return pro;
      });
    }
    return pending;
  };
}
