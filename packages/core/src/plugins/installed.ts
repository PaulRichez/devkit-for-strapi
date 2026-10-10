/**
 * Installed plugins — read the server side of every plugin Strapi would load
 * (internal + `package.json` dependencies declaring `strapi.kind: "plugin"`)
 * **statically**, from `node_modules`, without running any of it.
 *
 * Mirrors Strapi's own loader (verified in `@strapi/core` 5.x and
 * `@strapi/strapi` 4.25):
 *  - internal plugins are always enabled; their list is read from Strapi's
 *    `get-enabled-plugins` (with a per-major fallback);
 *  - an installed plugin is enabled unless `config/plugins` disables it;
 *  - the server entry is the package's `./strapi-server` export (v5, `require`
 *    condition) or `strapi-server.js`; no entry ⇒ no server part;
 *  - the entry's (default) export, called with `{ env }` if it is a function,
 *    yields `contentTypes`, `controllers`, `services`, `policies`,
 *    `middlewares`, `routes`.
 *
 * Every plugin carries `complete`: true only when *everything* above was read
 * exhaustively (no unknown step, no open object, no `src/extensions` override).
 * Only complete plugins may make DevKit report an unknown reference.
 */

import { type FileSystem, FileType } from '../fs/FileSystem';
import { dirname, join, normalize } from '../fs/paths';
import { parseMajor } from '../workspace/version';
import type { AttributeInfo, CodeArtifact, ContentType, ControllerAction, ArtifactKind } from '../model/types';
import { asRecord, asString, safeParse } from '../util/json';
import { configModuleValue, readPluginsConfig, type PluginDeclaration, type PluginsConfig } from './config';
import { isCallable, type Loc, type ObjValue, resolveDots, StaticEvaluator, toPlain, UNKNOWN, type Value } from './evaluate';
import { strapiExternals } from './shims';

export interface PluginRoute {
  /** Owning plugin name. */
  plugin: string;
  type: 'admin' | 'content-api';
  method: string;
  /** Path as declared on the route. */
  path: string;
  /** Mounted path (API prefix + router/route prefix + path). */
  fullPath: string;
  /** Qualified handler (`plugin::<name>.<controller>.<action>`), when a string. */
  handler?: string;
  /** `config.auth === false` — reachable without authentication. `undefined` when not literal. */
  public: boolean | undefined;
  policies: string[];
  middlewares: string[];
  loc?: Loc;
}

export type PluginOrigin = 'internal' | 'dependency';

export interface InstalledPlugin {
  name: string;
  packageName: string;
  version?: string;
  dir: string;
  origin: PluginOrigin;
  /** `uncertain`: enabled unless a non-literal/env-specific config says otherwise. */
  enabled: 'yes' | 'uncertain';
  hasServer: boolean;
  /** Everything read exhaustively — safe to report unknown refs against this plugin. */
  complete: boolean;
  /** Why the plugin is not complete (human-readable, for diagnostics/tests). */
  gaps: string[];
  contentTypes: ContentType[];
  artifacts: CodeArtifact[];
  routes: PluginRoute[];
}

export interface InstalledPluginsResult {
  /** `node_modules/@strapi/strapi` directory the plugins were resolved from. */
  strapiDir: string;
  strapiVersion: string;
  major: number;
  plugins: InstalledPlugin[];
  config: PluginsConfig;
  /** `api.rest.prefix` (default `/api`); `undefined` when not literal. */
  apiPrefix: string | undefined;
}

/** Fallback internal-plugin lists, used only if Strapi's own list can't be read. */
const INTERNAL_FALLBACK: Record<number, string[]> = {
  4: ['@strapi/plugin-content-manager', '@strapi/plugin-content-type-builder', '@strapi/plugin-email', '@strapi/plugin-upload'],
  5: [
    '@strapi/content-manager',
    '@strapi/content-type-builder',
    '@strapi/email',
    '@strapi/upload',
    '@strapi/i18n',
    '@strapi/content-releases',
    '@strapi/review-workflows',
  ],
};

const ARTIFACT_COLLECTIONS: Array<{ key: string; kind: ArtifactKind }> = [
  { key: 'services', kind: 'service' },
  { key: 'controllers', kind: 'controller' },
  { key: 'policies', kind: 'policy' },
  { key: 'middlewares', kind: 'middleware' },
];

async function readJson(fs: FileSystem, path: string): Promise<Record<string, unknown> | undefined> {
  try {
    return asRecord(safeParse(await fs.readFile(path)));
  } catch {
    return undefined;
  }
}

/** Node-style lookup of `<dir>/node_modules/<spec>` walking up from `fromDir`. */
export async function findPackageDir(fs: FileSystem, fromDir: string, spec: string): Promise<string | undefined> {
  let dir = normalize(fromDir);
  for (let i = 0; i < 64; i++) {
    const candidate = join(dir, 'node_modules', spec);
    if ((await fs.stat(join(candidate, 'package.json')))?.type === FileType.File) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
  return undefined;
}

/** Read Strapi's own INTERNAL_PLUGINS list (literal array in its loader). */
async function internalPluginSpecs(fs: FileSystem, strapiDir: string, major: number): Promise<string[]> {
  const candidates: string[] = [];
  if (major >= 5) {
    const coreDir = (await findPackageDir(fs, strapiDir, '@strapi/core')) ?? (await findPackageDir(fs, dirname(strapiDir), '@strapi/core'));
    if (coreDir) candidates.push(join(coreDir, 'dist', 'loaders', 'plugins', 'get-enabled-plugins.js'));
  } else {
    candidates.push(join(strapiDir, 'dist', 'core', 'loaders', 'plugins', 'get-enabled-plugins.js'));
    candidates.push(join(strapiDir, 'lib', 'core', 'loaders', 'plugins', 'get-enabled-plugins.js'));
  }
  for (const file of candidates) {
    try {
      const text = await fs.readFile(file);
      const m = /INTERNAL_PLUGINS\s*=\s*\[([^\]]*)\]/.exec(text);
      if (m) {
        const specs = [...m[1]!.matchAll(/['"]([^'"]+)['"]/g)].map((x) => x[1]!);
        if (specs.length) return specs;
      }
    } catch {
      /* try next */
    }
  }
  return INTERNAL_FALLBACK[major >= 5 ? 5 : 4] ?? [];
}

/** Resolve `exports['./strapi-server']` with the `require` condition (like `resolve.exports`). */
function strapiServerExport(pkg: Record<string, unknown>): string | undefined {
  const exp = asRecord(pkg.exports);
  if (!exp) return undefined;
  let target: unknown = exp['./strapi-server'];
  for (let i = 0; i < 4 && target && typeof target === 'object' && !Array.isArray(target); i++) {
    const t = target as Record<string, unknown>;
    target = t.require ?? t.node ?? t.default;
  }
  return typeof target === 'string' ? target : undefined;
}

function qualifyHandler(plugin: string, handler: string): string {
  const prefix = `plugin::${plugin}.`;
  if (handler.includes('::')) return handler;
  return `${prefix}${handler}`;
}

function joinRoutePath(...parts: string[]): string {
  let p = parts.join('').replace(/\/{2,}/g, '/');
  // koa-router mounts a prefixed `/` route without its trailing slash.
  if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
  return p || '/';
}

class PluginReader {
  constructor(
    private readonly ev: StaticEvaluator,
    private readonly plugin: InstalledPlugin,
    private readonly apiPrefix: string | undefined,
  ) {}

  private gap(why: string): void {
    this.plugin.complete = false;
    this.plugin.gaps.push(why);
  }

  /** The object a collection key holds on the server object (`{}` when absent). */
  private async collection(server: ObjValue, key: string): Promise<ObjValue | undefined> {
    if (!server.props.has(key)) {
      if (server.open) this.gap(`${key}: server object not exhaustive`);
      return undefined;
    }
    let v = await this.ev.getProp(server, key);
    if (isCallable(v)) v = await this.ev.call(v, [UNKNOWN('{ strapi }')]);
    if (v.k === 'nil') return undefined;
    if (v.k !== 'obj') {
      this.gap(`${key}: ${v.k === 'unknown' ? v.why : v.k}`);
      return undefined;
    }
    if (v.open) this.gap(`${key}: not exhaustive`);
    return v;
  }

  async read(entryFile: string): Promise<void> {
    const server = await configModuleValue(this.ev, entryFile);
    if (server.k !== 'obj') {
      this.gap(`server entry: ${server.k === 'unknown' ? server.why : server.k}`);
      return;
    }
    if (server.open) this.gap('server object not exhaustive');
    await this.readContentTypes(server);
    for (const { key, kind } of ARTIFACT_COLLECTIONS) await this.readArtifacts(server, key, kind);
    await this.readRoutes(server);
  }

  private async readContentTypes(server: ObjValue): Promise<void> {
    const cts = await this.collection(server, 'contentTypes');
    if (!cts) return;
    const name = this.plugin.name;
    for (const [ctName, thunk] of cts.props) {
      let def = await thunk();
      if (isCallable(def)) def = await this.ev.call(def, [UNKNOWN('{ strapi }')]);
      const keyLoc = cts.keyLocs.get(ctName);
      const schemaV = def.k === 'obj' ? await this.ev.getProp(def, 'schema') : UNKNOWN('content-type definition');
      const ct: ContentType = {
        uid: `plugin::${name}.${ctName}`,
        kind: 'collectionType',
        apiName: name,
        ctName,
        schemaPath: keyLoc?.file ?? this.plugin.dir,
        source: 'plugin',
        pluginName: name,
        info: {},
        attributes: {},
        installed: true,
        ...(keyLoc ? { defOffset: keyLoc.pos } : {}),
      };
      if (schemaV.k === 'obj') {
        const plain = asRecord(await toPlain(this.ev, schemaV)) ?? {};
        if (schemaV.loc) {
          ct.schemaPath = schemaV.loc.file;
          ct.defOffset = schemaV.loc.pos;
        }
        ct.kind = plain.kind === 'singleType' ? 'singleType' : 'collectionType';
        const info = asRecord(plain.info) ?? {};
        ct.info = {
          singularName: asString(info.singularName),
          pluralName: asString(info.pluralName),
          displayName: asString(info.displayName),
        };
        const attrsV = await this.ev.getProp(schemaV, 'attributes');
        if (attrsV.k === 'obj') {
          ct.attributes = await this.attributes(attrsV, ct.schemaPath);
          if (attrsV.open) ct.partialAttributes = true;
        } else {
          ct.partialAttributes = true;
        }
        if (schemaV.open) ct.partialAttributes = true;
      } else {
        ct.partialAttributes = true;
      }
      this.plugin.contentTypes.push(ct);
    }
  }

  private async attributes(attrsV: ObjValue, schemaPath: string): Promise<Record<string, AttributeInfo>> {
    const out: Record<string, AttributeInfo> = {};
    for (const [attrName, thunk] of attrsV.props) {
      if (attrName === '__proto__' || attrName === 'constructor' || attrName === 'prototype') continue;
      const def = asRecord(await toPlain(this.ev, await thunk())) ?? {};
      const kl = attrsV.keyLocs.get(attrName);
      const info: AttributeInfo = {
        name: attrName,
        type: asString(def.type) ?? 'unknown',
        keyOffset: kl && kl.file === schemaPath ? kl.pos : 0,
      };
      const target = asString(def.target);
      if (target) info.target = target;
      const component = asString(def.component);
      if (component) info.component = component;
      if (Array.isArray(def.components)) {
        const comps = def.components.filter((c): c is string => typeof c === 'string');
        if (comps.length) info.components = comps;
      }
      out[attrName] = info;
    }
    return out;
  }

  private async readArtifacts(server: ObjValue, key: string, kind: ArtifactKind): Promise<void> {
    const coll = await this.collection(server, key);
    if (!coll) return;
    const name = this.plugin.name;
    for (const [artName, thunk] of coll.props) {
      const keyLoc = coll.keyLocs.get(artName);
      const artifact: CodeArtifact = {
        ref: `plugin::${name}.${artName}`,
        kind,
        filePath: keyLoc?.file ?? this.plugin.dir,
        scope: 'plugin',
        name: artName,
        pluginName: name,
        installed: true,
        ...(keyLoc ? { defOffset: keyLoc.pos } : {}),
      };
      const v = await thunk();
      if (kind === 'service' || kind === 'controller') {
        let obj: Value = v;
        if (isCallable(obj)) obj = await this.ev.call(obj, [UNKNOWN('{ strapi }')]);
        if (obj.k === 'obj') {
          if (obj.loc) {
            artifact.filePath = obj.loc.file;
            artifact.defOffset = obj.loc.pos;
          }
          const actions: ControllerAction[] = [];
          for (const method of obj.props.keys()) {
            const kl = obj.keyLocs.get(method);
            const action: ControllerAction = { name: method, offset: kl?.pos ?? 0 };
            if (kl && kl.file !== artifact.filePath) action.filePath = kl.file;
            actions.push(action);
          }
          artifact.actions = actions;
          if (obj.open) artifact.hasSpread = true;
        } else {
          // Methods unknown (a class, a framework factory…): the artifact exists, its method list doesn't.
          artifact.actions = [];
          artifact.hasSpread = true;
          if (v.k === 'fn') {
            artifact.filePath = v.loc.file;
            artifact.defOffset = v.loc.pos;
          }
        }
      } else if (v.k === 'fn') {
        artifact.filePath = v.loc.file;
        artifact.defOffset = v.loc.pos;
      }
      this.plugin.artifacts.push(artifact);
    }
  }

  private async strings(v: Value): Promise<string[] | undefined> {
    if (v.k === 'nil') return [];
    if (v.k !== 'arr') return undefined;
    const out: string[] = [];
    for (const it of v.items) {
      const x = await this.ev.force(it);
      if (x.k === 'str') out.push(x.v);
      else if (x.k === 'obj') {
        const n = await this.ev.getProp(x, 'name');
        out.push(n.k === 'str' ? n.v : '<inline>');
      } else out.push('<inline>');
    }
    return out;
  }

  private async readRoutes(server: ObjValue): Promise<void> {
    const name = this.plugin.name;
    if (!server.props.has('routes')) {
      if (server.open) this.gap('routes: server object not exhaustive');
      return;
    }
    const v = await this.ev.getProp(server, 'routes');
    const routers: Array<{ type: Value; prefix: Value; routes: Value; hasPrefix: boolean }> = [];
    if (v.k === 'nil') return;
    if (v.k === 'arr') {
      routers.push({ type: { k: 'str', v: 'admin' }, prefix: { k: 'str', v: `/${name}` }, routes: v, hasPrefix: true });
    } else if (v.k === 'obj') {
      if (v.open) this.gap('routes: not exhaustive');
      for (const thunk of v.props.values()) {
        let r = await thunk();
        if (isCallable(r)) r = await this.ev.call(r, [UNKNOWN('{ strapi }')]);
        if (r.k !== 'obj') {
          this.gap(`routes: router ${r.k === 'unknown' ? r.why : r.k}`);
          continue;
        }
        routers.push({
          type: await this.ev.getProp(r, 'type'),
          prefix: await this.ev.getProp(r, 'prefix'),
          routes: await this.ev.getProp(r, 'routes'),
          hasPrefix: r.props.has('prefix'),
        });
      }
    } else {
      this.gap(`routes: ${v.k === 'unknown' ? v.why : v.k}`);
      return;
    }

    for (const router of routers) {
      const type: PluginRoute['type'] | undefined =
        router.type.k === 'nil' ? 'admin' : router.type.k === 'str' ? (router.type.v === 'content-api' ? 'content-api' : 'admin') : undefined;
      const routerPrefix = router.prefix.k === 'nil' ? `/${name}` : router.prefix.k === 'str' ? router.prefix.v : undefined;
      if (type === undefined || routerPrefix === undefined) this.gap('routes: router type/prefix not literal');
      if (router.routes.k !== 'arr') {
        if (router.routes.k !== 'nil') this.gap('routes: router routes not literal');
        continue;
      }
      if (router.routes.open) this.gap('routes: list not exhaustive');
      for (const it of router.routes.items) {
        const r = await this.ev.force(it);
        if (r.k !== 'obj') {
          this.gap('routes: route not literal');
          continue;
        }
        const method = await this.ev.getProp(r, 'method');
        const path = await this.ev.getProp(r, 'path');
        const handler = await this.ev.getProp(r, 'handler');
        const config = await this.ev.getProp(r, 'config');
        if (method.k !== 'str' || path.k !== 'str') {
          this.gap('routes: method/path not literal');
          continue;
        }
        let pub: boolean | undefined = false;
        let policies: string[] = [];
        let middlewares: string[] = [];
        let own: string | undefined = routerPrefix;
        if (config.k === 'obj') {
          const auth = await this.ev.getProp(config, 'auth');
          pub = auth.k === 'bool' ? !auth.v : auth.k === 'obj' || auth.k === 'nil' ? false : undefined;
          policies = (await this.strings(await this.ev.getProp(config, 'policies'))) ?? [];
          middlewares = (await this.strings(await this.ev.getProp(config, 'middlewares'))) ?? [];
          if (config.props.has('prefix')) {
            const p = await this.ev.getProp(config, 'prefix');
            own = p.k === 'str' ? p.v : p.k === 'nil' ? '' : undefined;
          }
        } else if (config.k !== 'nil') {
          pub = undefined;
        }
        const base = type === 'content-api' ? (this.apiPrefix ?? '/api') : '';
        const route: PluginRoute = {
          plugin: name,
          type: type ?? 'admin',
          method: method.v,
          path: path.v,
          fullPath: joinRoutePath(base, own ?? `/${name}`, path.v),
          public: pub,
          policies,
          middlewares,
          ...(r.loc ? { loc: r.loc } : {}),
        };
        if (handler.k === 'str') route.handler = qualifyHandler(name, handler.v);
        this.plugin.routes.push(route);
      }
    }
  }
}

/** `api.rest.prefix` from `config/api.*` (default `/api`). */
async function readApiPrefix(fs: FileSystem, root: string, ev: StaticEvaluator): Promise<string | undefined> {
  for (const ext of ['.ts', '.js', '.mjs', '.cjs']) {
    const file = join(root, 'config', `api${ext}`);
    if ((await fs.stat(file))?.type !== FileType.File) continue;
    const v = await configModuleValue(ev, file);
    if (v.k !== 'obj') return undefined;
    const rest = await ev.getProp(v, 'rest');
    if (rest.k === 'nil') return '/api';
    if (rest.k !== 'obj') return undefined;
    const prefix = await ev.getProp(rest, 'prefix');
    if (prefix.k === 'nil') return rest.open ? undefined : '/api';
    return prefix.k === 'str' ? prefix.v : undefined;
  }
  return '/api';
}

function enabledState(decl: PluginDeclaration | undefined, config: PluginsConfig): 'yes' | 'uncertain' | 'no' {
  if (!decl) return config.exhaustive ? 'yes' : 'uncertain';
  if (decl.enabled === false) return decl.envOverride ? 'uncertain' : 'no';
  if (decl.enabled === 'unknown' || decl.envOverride) return 'uncertain';
  return 'yes';
}

/**
 * Read every enabled installed plugin of the Strapi project at `root`.
 * Returns `undefined` when Strapi isn't installed (no `node_modules`) — callers
 * then keep today's behaviour (installed plugins stay unverifiable).
 */
export async function readInstalledPlugins(fs: FileSystem, root: string): Promise<InstalledPluginsResult | undefined> {
  const strapiDir = await findPackageDir(fs, root, '@strapi/strapi');
  if (!strapiDir) return undefined;
  const strapiPkg = await readJson(fs, join(strapiDir, 'package.json'));
  const strapiVersion = asString(strapiPkg?.version);
  const major = strapiVersion ? parseMajor(strapiVersion) : undefined;
  if (!strapiVersion || !major) return undefined;

  const ev = new StaticEvaluator(fs, {}, strapiExternals);
  const config = await readPluginsConfig(fs, root, ev);
  const apiPrefix = await readApiPrefix(fs, root, ev);
  const projectPkg = await readJson(fs, join(root, 'package.json'));
  const deps = Object.keys(asRecord(projectPkg?.dependencies) ?? {});

  const candidates: Array<{ spec: string; dir: string; pkg: Record<string, unknown>; origin: PluginOrigin }> = [];
  const seen = new Set<string>();
  for (const spec of await internalPluginSpecs(fs, strapiDir, major)) {
    const dir = (await findPackageDir(fs, strapiDir, spec)) ?? (await findPackageDir(fs, root, spec));
    const pkg = dir ? await readJson(fs, join(dir, 'package.json')) : undefined;
    if (dir && pkg) candidates.push({ spec, dir, pkg, origin: 'internal' });
  }
  for (const spec of deps) {
    const dir = await findPackageDir(fs, root, spec);
    const pkg = dir ? await readJson(fs, join(dir, 'package.json')) : undefined;
    if (dir && pkg && asRecord(pkg.strapi)?.kind === 'plugin') candidates.push({ spec, dir, pkg, origin: 'dependency' });
  }

  const plugins: InstalledPlugin[] = [];
  for (const c of candidates) {
    const strapiInfo = asRecord(c.pkg.strapi) ?? {};
    const name = asString(strapiInfo.name);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    const decl = config.declarations.get(name);
    // A declared `resolve` makes it a local plugin — indexed from the project source instead.
    if (decl?.resolve !== undefined) continue;
    const state = c.origin === 'internal' ? 'yes' : enabledState(decl, config);
    if (state === 'no') continue;

    const plugin: InstalledPlugin = {
      name,
      packageName: asString(c.pkg.name) ?? c.spec,
      ...(asString(c.pkg.version) ? { version: asString(c.pkg.version)! } : {}),
      dir: c.dir,
      origin: c.origin,
      enabled: state,
      hasServer: false,
      complete: true,
      gaps: [],
      contentTypes: [],
      artifacts: [],
      routes: [],
    };
    if (state === 'uncertain') {
      plugin.complete = false;
      plugin.gaps.push('enabled state not literal');
    }

    const exported = major >= 5 ? strapiServerExport(c.pkg) : undefined;
    const entry = resolveDots(join(c.dir, exported ?? './strapi-server.js'));
    if ((await fs.stat(entry))?.type === FileType.File) {
      plugin.hasServer = true;
      await new PluginReader(ev, plugin, apiPrefix).read(entry);
    }
    // `src/extensions/<plugin>/strapi-server.*` can rewrite the plugin at boot.
    for (const ext of ['.js', '.ts', '.mjs', '.cjs']) {
      if ((await fs.stat(join(root, 'src', 'extensions', name, `strapi-server${ext}`)))?.type === FileType.File) {
        plugin.complete = false;
        plugin.gaps.push(`extended by src/extensions/${name}/strapi-server${ext}`);
        break;
      }
    }
    plugins.push(plugin);
  }
  return { strapiDir, strapiVersion, major, plugins, config, apiPrefix };
}

