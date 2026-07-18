import { describe, expect, it } from 'vitest';
import {
  isPro,
  isProTool,
  proRequired,
  proToolNames,
  resolveLicense,
  type CachedLicense,
  type LicenseCache,
  type LicenseValidation,
  type LicenseVerifier,
} from '../src/index';

const NOW = 1_700_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

/** A verifier returning a fixed result, with a call counter (asserts no network). */
function verifier(result: LicenseValidation): LicenseVerifier & { calls: number } {
  const v = {
    calls: 0,
    validate(_key: string): Promise<LicenseValidation> {
      v.calls++;
      return Promise.resolve(result);
    },
  };
  return v;
}

/** An in-memory cache (the disk impl lives in the clients). */
function memCache(): LicenseCache & { value?: CachedLicense } {
  const c: { value?: CachedLicense } & LicenseCache = {
    value: undefined,
    read: () => c.value,
    write: (e) => {
      c.value = e;
    },
  };
  return c;
}

/** A verifier that is always unreachable (simulates offline). */
const offline: LicenseVerifier = { validate: () => Promise.reject(new Error('offline')) };

describe('resolveLicense', () => {
  it('no key → free', async () => {
    const r = await resolveLicense({ key: undefined, verifier: verifier({ valid: true }), now: NOW });
    expect(isPro(r)).toBe(false);
    expect(r.reason).toBe('no-key');
  });

  it('honours the dev override only in dev mode', async () => {
    const v = verifier({ valid: false });
    const dev = await resolveLicense({ key: 'dev', verifier: v, now: NOW, devMode: true });
    expect(isPro(dev)).toBe(true);
    expect(dev.reason).toBe('dev-override');
    expect(v.calls).toBe(0); // short-circuits, never hits the verifier

    const prod = await resolveLicense({ key: 'dev', verifier: v, now: NOW, devMode: false });
    expect(isPro(prod)).toBe(false); // 'dev' is just an unknown key in production
  });

  it('a valid key → pro, and writes the cache', async () => {
    const cache = memCache();
    const r = await resolveLicense({ key: 'polar_x', verifier: verifier({ valid: true }), cache, now: NOW });
    expect(isPro(r)).toBe(true);
    expect(r.reason).toBe('valid');
    expect(cache.value?.valid).toBe(true);
  });

  it('an unknown key → free', async () => {
    const r = await resolveLicense({ key: 'nope', verifier: verifier({ valid: false }), now: NOW });
    expect(isPro(r)).toBe(false);
    expect(r.reason).toBe('invalid');
  });

  it('an expired key → free even if the verifier says valid', async () => {
    const r = await resolveLicense({ key: 'polar_x', verifier: verifier({ valid: true, expiresAt: NOW - DAY }), now: NOW });
    expect(isPro(r)).toBe(false);
    expect(r.reason).toBe('expired');
  });

  it('reuses a fresh cache without calling the verifier', async () => {
    const cache = memCache();
    await resolveLicense({ key: 'polar_x', verifier: verifier({ valid: true }), cache, now: NOW }); // seeds the cache
    const v = verifier({ valid: true });
    const r = await resolveLicense({ key: 'polar_x', verifier: v, cache, now: NOW + DAY }); // within the 7d TTL
    expect(r.reason).toBe('cached');
    expect(v.calls).toBe(0);
  });

  it('re-verifies online once the TTL has passed', async () => {
    const cache = memCache();
    await resolveLicense({ key: 'polar_x', verifier: verifier({ valid: true }), cache, now: NOW });
    const v = verifier({ valid: true });
    const r = await resolveLicense({ key: 'polar_x', verifier: v, cache, now: NOW + 8 * DAY }); // past the 7d TTL
    expect(r.reason).toBe('valid');
    expect(v.calls).toBe(1);
  });

  it('stays pro offline when a recent valid cache exists (grace window)', async () => {
    const cache = memCache();
    await resolveLicense({ key: 'polar_x', verifier: verifier({ valid: true }), cache, now: NOW });
    const r = await resolveLicense({ key: 'polar_x', verifier: offline, cache, now: NOW + 10 * DAY });
    expect(isPro(r)).toBe(true);
    expect(r.reason).toBe('cached-offline');
  });

  it('drops to free offline once past the grace window', async () => {
    const cache = memCache();
    await resolveLicense({ key: 'polar_x', verifier: verifier({ valid: true }), cache, now: NOW });
    const r = await resolveLicense({ key: 'polar_x', verifier: offline, cache, now: NOW + 40 * DAY });
    expect(isPro(r)).toBe(false);
    expect(r.reason).toBe('unverified');
  });

  it('offline with no cache → free', async () => {
    const r = await resolveLicense({ key: 'polar_x', verifier: offline, now: NOW });
    expect(isPro(r)).toBe(false);
    expect(r.reason).toBe('unverified');
  });

  it('never reuses a cache from a different key', async () => {
    const cache = memCache();
    await resolveLicense({ key: 'old-key', verifier: verifier({ valid: true }), cache, now: NOW });
    // a new key while offline can't fall back to the old key's cached entitlement
    const r = await resolveLicense({ key: 'new-key', verifier: offline, cache, now: NOW + DAY });
    expect(isPro(r)).toBe(false);
  });
});

describe('proRequired upsell', () => {
  it('maps a tool to its feature and includes buy + activate hints', () => {
    const u = proRequired('plan_rename_method');
    expect(u.proRequired).toBe(true);
    expect(u.feature).toBe('Propagated rename');
    expect(u.tool).toBe('plan_rename_method');
    expect(u.getPro).toContain('devkit-for-strapi');
    expect(u.activate).toContain('DEVKIT_LICENSE_KEY');
  });

  it('gates every plan_*/apply_* tool but no read tool', () => {
    expect(isProTool('apply_edits')).toBe(true);
    expect(isProTool('plan_move')).toBe(true);
    expect(isProTool('get_schema')).toBe(false); // a free read tool
    expect(proToolNames()).toContain('apply_rename');
    expect(proToolNames()).not.toContain('resolve');
  });
});
