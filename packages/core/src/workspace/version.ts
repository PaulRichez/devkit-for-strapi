import type { StrapiVersion, VersionSignals } from '../model/types';
import { asRecord, asString } from '../util/json';

/** Extract the leading major version number from a semver range spec. */
export function parseMajor(spec: string | undefined): number | undefined {
  if (!spec) return undefined;
  const m = spec.match(/(\d+)\s*\./) ?? spec.match(/^\D*(\d+)/);
  return m ? Number(m[1]) : undefined;
}

/** The newest Strapi major DevKit knows: a later one is read as it — and said. */
export const LATEST_KNOWN_MAJOR = 5;

/**
 * A sentence when the project's Strapi (the installed version, else the declared
 * range) is newer than DevKit knows — said with the version DevKit reads it as
 * (`readAs`) — else undefined.
 */
export function unsupportedVersion(installed: string | undefined, declaredMajor: number | undefined, readAs: StrapiVersion = LATEST_KNOWN_MAJOR): string | undefined {
  const major = parseMajor(installed) ?? declaredMajor;
  if (major === undefined || major <= LATEST_KNOWN_MAJOR) return undefined;
  return `Strapi ${major} isn't supported yet: DevKit reads this project as Strapi ${readAs}, so some names, routes or checks may be wrong.`;
}

export interface VersionResult {
  version: StrapiVersion;
  signals: VersionSignals;
}

/**
 * Detect the Strapi major version of a project from its parsed package.json.
 * Defaults to v5 (the current default) when the spec can't be parsed.
 */
export function detectVersion(pkgJson: unknown): VersionResult {
  const json = asRecord(pkgJson) ?? {};
  const deps = asRecord(json.dependencies) ?? {};
  const devDeps = asRecord(json.devDependencies) ?? {};
  const spec = asString(deps['@strapi/strapi']) ?? asString(devDeps['@strapi/strapi']);
  const major = parseMajor(spec);
  const version: StrapiVersion = major === 4 ? 4 : 5;
  const signals: VersionSignals = {};
  if (major !== undefined) signals.packageMajor = major;
  if (spec !== undefined) signals.spec = spec;
  return { version, signals };
}
