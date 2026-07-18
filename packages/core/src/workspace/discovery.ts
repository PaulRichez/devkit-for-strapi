import { type FileSystem, FileType } from '../fs/FileSystem';
import { dirname, join, normalize } from '../fs/paths';
import { asRecord, asString, safeParse } from '../util/json';

const PRUNE = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'out',
  '.cache',
  '.next',
  '.turbo',
  '.svelte-kit',
  'coverage',
]);

const MAX_DEPTH = 8;

/** True if a package.json declares `@strapi/strapi` as a (dev)dependency. */
export function isStrapiPackageJson(raw: string): boolean {
  const json = asRecord(safeParse(raw));
  if (!json) return false;
  const deps = asRecord(json.dependencies) ?? {};
  const devDeps = asRecord(json.devDependencies) ?? {};
  return asString(deps['@strapi/strapi']) !== undefined || asString(devDeps['@strapi/strapi']) !== undefined;
}

/**
 * Discover Strapi project roots by content — scanning every package.json for
 * `@strapi/strapi`. Never assumes "workspace root = Strapi root". Prunes heavy
 * directories and bounds depth so large monorepos stay fast.
 */
export async function discoverProjectRoots(fs: FileSystem, folders: string[]): Promise<string[]> {
  const roots: string[] = [];
  const seen = new Set<string>();

  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > MAX_DEPTH) return;
    let entries;
    try {
      entries = await fs.readDirectory(dir);
    } catch {
      return;
    }

    if (entries.some((e) => e.type === FileType.File && e.name === 'package.json')) {
      const pkgPath = join(dir, 'package.json');
      try {
        if (isStrapiPackageJson(await fs.readFile(pkgPath)) && !seen.has(dir)) {
          seen.add(dir);
          roots.push(dir);
        }
      } catch {
        // unreadable package.json — ignore
      }
    }

    for (const e of entries) {
      if (e.type === FileType.Directory && !PRUNE.has(e.name)) {
        await walk(join(dir, e.name), depth + 1);
      }
    }
  };

  for (const folder of folders) {
    await walk(normalize(folder), 0);
  }
  return roots;
}

/**
 * Walk **up** from a path to the nearest ancestor that is a Strapi project root
 * (a `package.json` declaring `@strapi/strapi`). Lets an agent point at the file
 * it is editing and have the project located on demand, with no startup config.
 * `startDir` should already be a directory (callers pass `dirname(file)`).
 */
export async function findStrapiRootUp(fs: FileSystem, startDir: string): Promise<string | undefined> {
  let dir = normalize(startDir);
  for (;;) {
    try {
      if (isStrapiPackageJson(await fs.readFile(join(dir, 'package.json')))) return dir;
    } catch {
      // no/unreadable package.json here — keep climbing
    }
    const parent = dirname(dir);
    if (parent === dir) return undefined; // reached the filesystem root
    dir = parent;
  }
}
