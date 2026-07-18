import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createLicenseCheck, fileCache, polarVerifier } from '../src/license';

/** A `fetch` stand-in returning a fixed status + JSON body. */
const fakeFetch = (status: number, body: unknown): typeof fetch =>
  (() => Promise.resolve({ ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) } as Response)) as unknown as typeof fetch;

const tmpFile = (): string => join(mkdtempSync(join(tmpdir(), 'devkit-lic-')), 'license.json');

describe('polarVerifier', () => {
  it('is invalid for every key when no org id is wired (locked default)', async () => {
    const v = polarVerifier(undefined, fakeFetch(200, { status: 'granted' }));
    expect(await v.validate('any')).toEqual({ valid: false });
  });

  it('a 200 "granted" → valid, perpetual', async () => {
    const v = polarVerifier('org_1', fakeFetch(200, { status: 'granted', expires_at: null }));
    expect(await v.validate('k')).toEqual({ valid: true, expiresAt: null });
  });

  it('parses an expiry date', async () => {
    const v = polarVerifier('org_1', fakeFetch(200, { status: 'granted', expires_at: '2030-01-01T00:00:00Z' }));
    expect((await v.validate('k')).expiresAt).toBe(Date.parse('2030-01-01T00:00:00Z'));
  });

  it('a 4xx → invalid (a definite "no")', async () => {
    const v = polarVerifier('org_1', fakeFetch(404, {}));
    expect((await v.validate('k')).valid).toBe(false);
  });

  it('a 5xx throws → resolveLicense can fall back to the offline cache', async () => {
    const v = polarVerifier('org_1', fakeFetch(503, {}));
    await expect(v.validate('k')).rejects.toThrow();
  });
});

describe('fileCache', () => {
  it('round-trips an entry; returns undefined when absent or corrupt', () => {
    const cache = fileCache(tmpFile());
    expect(cache.read()).toBeUndefined();
    const entry = { keyHash: 'h', valid: true, checkedAt: 123, expiresAt: null };
    cache.write(entry);
    expect(cache.read()).toEqual(entry);
  });
});

describe('createLicenseCheck', () => {
  const ENV_KEYS = ['DEVKIT_DEV', 'DEVKIT_LICENSE_KEY', 'DEVKIT_LICENSE_CACHE', 'DEVKIT_POLAR_ORG_ID'];
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('DEVKIT_DEV=1 + DEVKIT_LICENSE_KEY=dev → pro (the dogfood override), and memoizes', async () => {
    process.env.DEVKIT_DEV = '1';
    process.env.DEVKIT_LICENSE_KEY = 'dev';
    process.env.DEVKIT_LICENSE_CACHE = tmpFile();
    delete process.env.DEVKIT_POLAR_ORG_ID;
    const isLicensed = createLicenseCheck();
    expect(await isLicensed()).toBe(true);
    expect(await isLicensed()).toBe(true); // memoized — no re-resolve
  });

  it('the dev override is ignored without DEVKIT_DEV (no env backdoor in prod mode)', async () => {
    delete process.env.DEVKIT_DEV;
    process.env.DEVKIT_LICENSE_KEY = 'dev';
    process.env.DEVKIT_LICENSE_CACHE = tmpFile();
    delete process.env.DEVKIT_POLAR_ORG_ID;
    expect(await createLicenseCheck()()).toBe(false);
  });

  it('no key → free', async () => {
    delete process.env.DEVKIT_DEV;
    delete process.env.DEVKIT_LICENSE_KEY;
    process.env.DEVKIT_LICENSE_CACHE = tmpFile();
    expect(await createLicenseCheck()()).toBe(false);
  });
});
