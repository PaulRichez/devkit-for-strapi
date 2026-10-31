import { type FileSystem, FileType } from '../fs/FileSystem';
import { dirname, isPathInside, join, normalize } from '../fs/paths';
import { asRecord, asString, safeParse } from '../util/json';
import { type IgnoreRule, isIgnoredDir, parseGitignore } from './gitignore';

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

/** True if a package.json is a Strapi **plugin** package (`strapi.kind: "plugin"`). */
export function isStrapiPluginPackageJson(raw: string): boolean {
  const json = asRecord(safeParse(raw));
  return asRecord(json?.strapi)?.kind === 'plugin';
}

/**
 * Discover Strapi project roots by content — scanning every package.json for
 * `@strapi/strapi`. Never assumes "workspace root = Strapi root". Prunes heavy
 * directories and the folders git ignores (a release build, a backup copy of the
 * app: every project twice otherwise), and bounds depth so large monorepos stay fast.
 * The folders passed are always walked: one git ignores is reached by passing it. A
 * folder holding its own repository (`.git`) is walked too, with its own rules only.
 */
export async function discoverProjectRoots(fs: FileSystem, folders: string[]): Promise<string[]> {
  const roots: string[] = [];
  const seen = new Set<string>();

  const walk = async (dir: string, depth: number, inherited: readonly IgnoreRule[]): Promise<void> => {
    if (depth > MAX_DEPTH) return;
    let entries;
    try {
      entries = await fs.readDirectory(dir);
    } catch {
      return;
    }
    // A repository of its own (a clone inside another folder): git applies none of the outer rules there.
    let rules = entries.some((e) => e.name === '.git') ? [] : inherited;
    if (entries.some((e) => e.type === FileType.File && e.name === '.gitignore')) {
      try {
        rules = [...inherited, ...parseGitignore(await fs.readFile(join(dir, '.gitignore')), dir)];
      } catch {
        // unreadable .gitignore — walk as if it weren't there
      }
    }

    if (entries.some((e) => e.type === FileType.File && e.name === 'package.json')) {
      const pkgPath = join(dir, 'package.json');
      try {
        const raw = await fs.readFile(pkgPath);
        // A plugin package nested inside an app (`src/plugins/<name>/package.json`
        // declaring @strapi/strapi as a peer/dev dep) belongs to that app — it is
        // indexed as one of its local plugins, not as a project of its own.
        const nestedPlugin = isStrapiPluginPackageJson(raw) && roots.some((r) => isPathInside(r, dir));
        if (isStrapiPackageJson(raw) && !nestedPlugin && !seen.has(dir)) {
          seen.add(dir);
          roots.push(dir);
        }
      } catch {
        // unreadable package.json — ignore
      }
    }

    for (const e of entries) {
      if (e.type !== FileType.Directory || PRUNE.has(e.name)) continue;
      const sub = join(dir, e.name);
      if (!isIgnoredDir(rules, sub) || (await fs.exists(join(sub, '.git')))) await walk(sub, depth + 1, rules);
    }
  };

  for (const folder of folders) {
    await walk(normalize(folder), 0, []);
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
  // A Strapi plugin package found on the way up: returned only if no app contains it.
  let pluginRoot: string | undefined;
  for (;;) {
    try {
      const raw = await fs.readFile(join(dir, 'package.json'));
      if (isStrapiPackageJson(raw)) {
        if (!isStrapiPluginPackageJson(raw)) return dir;
        pluginRoot ??= dir;
      }
    } catch {
      // no/unreadable package.json here — keep climbing
    }
    const parent = dirname(dir);
    if (parent === dir) return pluginRoot; // reached the filesystem root
    dir = parent;
  }
}
