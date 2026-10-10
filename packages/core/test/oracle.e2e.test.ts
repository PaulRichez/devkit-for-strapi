/**
 * Oracle e2e — compares DevKit's STATIC reading of installed plugins against what
 * a real Strapi registers (scripts/oracle/strapi-registries.cjs, register level).
 *
 * Opt-in: set DEVKIT_ORACLE_APPS to a `;`-separated list of installed Strapi app
 * roots (v4 and v5). Skipped otherwise. The contract checked:
 *  - DevKit never invents: every plugin entry it reports exists in Strapi;
 *  - a plugin DevKit marks `complete` matches Strapi exactly (names, controller
 *    actions when not `hasSpread`, routes).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createEngine } from '../src/engine';
import { listRoutes } from '../src/index/routes';
import { readInstalledPlugins } from '../src/plugins/installed';
import { NodeFileSystem } from './helpers/nodeFs';

const APPS = (process.env.DEVKIT_ORACLE_APPS ?? '').split(';').map((s) => s.trim()).filter(Boolean);
const RUNNER = resolve(__dirname, '../../../scripts/oracle/strapi-registries.cjs');
const MARK = '@@DEVKIT_ORACLE@@';

interface OracleResult {
  version: string;
  enabledPlugins: string[];
  registries: Record<string, Record<string, { methods?: string[] | null; attributes?: string[] }>>;
  routes: Array<{ owner: string; type: string; method: string; fullPath: string; handler: string | null; public: boolean }>;
}

function runOracle(app: string): OracleResult {
  // Optional cache for fast iteration: DEVKIT_ORACLE_CACHE=<dir> reuses a previous run.
  const cacheDir = process.env.DEVKIT_ORACLE_CACHE;
  const cacheFile = cacheDir ? join(cacheDir, `${app.replace(/[^a-z0-9]+/gi, '_')}.json`) : undefined;
  if (cacheFile && existsSync(cacheFile)) return JSON.parse(readFileSync(cacheFile, 'utf8')) as OracleResult;
  const result = runOracleNow(app);
  if (cacheFile) {
    mkdirSync(cacheDir!, { recursive: true });
    writeFileSync(cacheFile, JSON.stringify(result));
  }
  return result;
}

function runOracleNow(app: string): OracleResult {
  const r = spawnSync(process.execPath, [RUNNER], { cwd: app, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 180_000 });
  const out = r.stdout ?? '';
  const a = out.indexOf(MARK);
  const b = out.lastIndexOf(MARK);
  if (a < 0 || b <= a) throw new Error(`oracle failed for ${app}: ${r.stderr?.slice(-2000)}`);
  return JSON.parse(out.slice(a + MARK.length, b)) as OracleResult;
}

const KIND_OF: Record<string, string> = { service: 'services', controller: 'controllers', policy: 'policies', middleware: 'middlewares' };

const routeKey = (r: { type: string; method: string; fullPath: string; handler?: string | null }): string =>
  `${r.type} ${String(r.method).toUpperCase()} ${r.fullPath} -> ${r.handler ?? '<fn>'}`;

describe.skipIf(APPS.length === 0)('oracle: static installed-plugin reading vs real Strapi', () => {
  for (const app of APPS) {
    it(`matches Strapi for ${app}`, { timeout: 240_000 }, async () => {
      const oracle = runOracle(app);
      const t0 = Date.now();
      const stat = await readInstalledPlugins(new NodeFileSystem(), app.replace(/\\/g, '/'));
      const staticMs = Date.now() - t0;
      expect(stat, 'Strapi installed').toBeDefined();

      const lines: string[] = [`\n=== ${app} — Strapi ${oracle.version} — static read ${staticMs} ms ===`];
      const problems: string[] = [];
      const totals = { artifacts: 0, exhaustive: 0 };

      for (const p of stat!.plugins) {
        const ns = `plugin::${p.name}.`;
        const inOracle = (kind: string): Set<string> =>
          new Set(Object.keys(oracle.registries[kind] ?? {}).filter((k) => k.startsWith(ns)));
        const report: string[] = [];
        const cmp = (label: string, mine: Set<string>, truth: Set<string>): void => {
          const extra = [...mine].filter((x) => !truth.has(x));
          const missing = [...truth].filter((x) => !mine.has(x));
          if (extra.length) {
            report.push(`  ${label} EXTRA (invented): ${extra.join(', ')}`);
            problems.push(`${p.name} ${label} extra: ${extra.join(', ')}`);
          }
          if (missing.length) {
            report.push(`  ${label} missing: ${missing.join(', ')}`);
            if (p.complete) problems.push(`${p.name} ${label} missing although complete: ${missing.join(', ')}`);
          }
        };
        cmp('content-types', new Set(p.contentTypes.map((c) => c.uid)), inOracle('content-types'));
        // Attributes: never invent one; when DevKit claims the full list, Strapi's must only add its own
        // automatic fields (timestamps, creator, publication, i18n, document id).
        const AUTO = new Set(['createdAt', 'updatedAt', 'publishedAt', 'createdBy', 'updatedBy', 'locale', 'localizations', 'documentId']);
        for (const ct of p.contentTypes) {
          const truth = oracle.registries['content-types']?.[ct.uid]?.attributes;
          if (!truth) continue;
          // `src/extensions/<plugin>/content-types/<ct>/schema.json` replaces the plugin's attribute
          // list (Strapi spreads the extension schema over the original) — indexed from the project.
          if (existsSync(join(app, 'src', 'extensions', p.name, 'content-types', ct.ctName, 'schema.json'))) continue;
          const mine = Object.keys(ct.attributes);
          const extra = mine.filter((a) => !truth.includes(a));
          if (extra.length) problems.push(`${ct.uid} attributes extra: ${extra.join(', ')}`);
          if (!ct.partialAttributes) {
            const missing = truth.filter((a) => !mine.includes(a) && !AUTO.has(a));
            if (missing.length) problems.push(`${ct.uid} attributes missing although exhaustive: ${missing.join(', ')}`);
          }
        }
        for (const kind of Object.keys(KIND_OF)) {
          cmp(KIND_OF[kind]!, new Set(p.artifacts.filter((a) => a.kind === kind).map((a) => a.ref)), inOracle(KIND_OF[kind]!));
        }
        // Controller/service methods, where DevKit claims an exhaustive list.
        for (const a of p.artifacts) {
          if (a.kind !== 'controller' && a.kind !== 'service') continue;
          const truth = oracle.registries[KIND_OF[a.kind]!]?.[a.ref]?.methods;
          if (!truth) continue;
          const mine = new Set((a.actions ?? []).map((x) => x.name));
          const extra = [...mine].filter((x) => !truth.includes(x));
          if (extra.length) {
            report.push(`  ${a.ref} methods EXTRA: ${extra.join(', ')}`);
            problems.push(`${a.ref} methods extra: ${extra.join(', ')}`);
          }
          if (!a.hasSpread) {
            const missing = truth.filter((x) => !mine.has(x));
            if (missing.length) {
              report.push(`  ${a.ref} methods missing: ${missing.join(', ')}`);
              problems.push(`${a.ref} methods missing although exhaustive: ${missing.join(', ')}`);
            }
          }
        }
        const truthRoutes = new Set(oracle.routes.filter((r) => r.owner === `plugin::${p.name}`).map(routeKey));
        cmp('routes', new Set(p.routes.map(routeKey)), truthRoutes);
        const withMethods = p.artifacts.filter((a) => a.kind === 'controller' || a.kind === 'service');
        const exhaustive = withMethods.filter((a) => !a.hasSpread).length;
        totals.artifacts += withMethods.length;
        totals.exhaustive += exhaustive;
        lines.push(
          `${p.complete ? 'OK ' : '.. '} ${p.name} (${p.origin}${p.hasServer ? '' : ', no server'}) ` +
            `ct=${p.contentTypes.length} art=${p.artifacts.length} routes=${p.routes.length} methods-known=${exhaustive}/${withMethods.length}` +
            (p.gaps.length ? `  gaps: ${p.gaps.slice(0, 4).join(' | ')}${p.gaps.length > 4 ? ` (+${p.gaps.length - 4})` : ''}` : ''),
          ...report,
        );
      }
      const staticNames = new Set(stat!.plugins.map((p) => p.name));
      const localDeclared = [...stat!.config.declarations].filter(([, d]) => d.resolve !== undefined).map(([n]) => n);
      const unseen = oracle.enabledPlugins.filter((n) => !staticNames.has(n) && !localDeclared.includes(n));
      if (unseen.length) {
        lines.push(`  plugins Strapi loads but DevKit did not list: ${unseen.join(', ')}`);
        problems.push(`unlisted plugins: ${unseen.join(', ')}`);
      }
      lines.push(`  services/controllers with an exhaustive method list: ${totals.exhaustive}/${totals.artifacts}`);
      console.log(lines.join('\n'));
      expect(problems).toEqual([]);
    });
  }
});


describe.skipIf(APPS.length === 0)('oracle: project + local-plugin routes vs real Strapi', () => {
  for (const app of APPS) {
    it(`routes match Strapi for ${app}`, { timeout: 240_000 }, async () => {
      const oracle = runOracle(app);
      const engine = createEngine(new NodeFileSystem());
      await engine.init([app.replace(/\\/g, '/')]);
      const project = engine.allProjects().find((p) => normalizeRoot(p.root) === normalizeRoot(app))!;
      expect(project, 'project discovered').toBeDefined();
      const local = new Set(project.index.pluginNames);
      const qualify = (owner: string, h: string | null | undefined): string =>
        !h || h === '<inline>' ? '<fn>' : h.includes('::') ? h : `${owner}.${h}`;
      const key = (type: string | undefined, method: string, fullPath: string | undefined, owner: string, h: string | null | undefined): string =>
        `${type} ${method.toUpperCase()} ${fullPath} -> ${qualify(owner, h)}`;
      const isOurs = (owner: string): boolean => owner.startsWith('api::') || local.has(owner.slice('plugin::'.length));
      const truth = new Set(oracle.routes.filter((r) => isOurs(r.owner)).map((r) => key(r.type, r.method, r.fullPath, r.owner, r.handler)));
      const mine = new Set(
        (await listRoutes(new NodeFileSystem(), project, { admin: true }))
          .filter((r) => r.origin !== 'installed-plugin')
          .map((r) => key(r.type, r.method, r.fullPath, r.owner ?? '?', r.handler)),
      );
      const extra = [...mine].filter((x) => !truth.has(x));
      const missing = [...truth].filter((x) => !mine.has(x));
      console.log(`\n=== routes ${app}: ${mine.size} static / ${truth.size} Strapi (api + local plugins)` +
        (extra.length ? `\n  EXTRA: ${extra.join('\n         ')}` : '') + (missing.length ? `\n  missing: ${missing.join('\n           ')}` : ''));
      expect({ extra, missing }).toEqual({ extra: [], missing: [] });
    });
  }
});

function normalizeRoot(p: string): string {
  return p.replace(/\\/g, '/').replace(/^([A-Z]):/, (_, d: string) => `${d.toLowerCase()}:`).replace(/\/$/, '');
}
