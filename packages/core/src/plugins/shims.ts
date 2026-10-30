/**
 * Models of the few framework helpers Strapi plugins call while *declaring* their
 * server parts. Evaluating `@strapi/utils` itself would mean walking a large
 * dependency graph; these helpers are tiny and stable, so DevKit models them
 * exactly (each model cites the source it mirrors). Anything not modelled stays
 * `unknown` — the plugin is then reported incomplete, never guessed.
 */

import { isAbsolute, join } from '../fs/paths';
import { isCallable, memo, type ObjValue, resolveDots, type StaticEvaluator, UNKNOWN, type Value } from './evaluate';

function obj(entries: Record<string, () => Promise<Value>>): ObjValue {
  const props = new Map<string, () => Promise<Value>>();
  for (const [k, v] of Object.entries(entries)) props.set(k, v);
  return { k: 'obj', props, keyLocs: new Map(), open: false };
}

/**
 * `@strapi/utils` → `createContentApiRoutesFactory(buildRoutes)` (5.x,
 * `dist/content-api-router.js`): returns a function producing
 * `{ type: 'content-api', routes: buildRoutes() }`.
 */
function utilsModule(ev: StaticEvaluator): ObjValue {
  const m = obj({
    createContentApiRoutesFactory: async () => ({
      k: 'native',
      name: 'createContentApiRoutesFactory',
      impl: async ([build]) => {
        if (!build || !isCallable(build)) return UNKNOWN('createContentApiRoutesFactory: non-function');
        // Built once and shared, like Strapi's; a factory reading its own routes is a cycle → unknown.
        const routes = memo(() => ev.call(build, []));
        return {
          k: 'native',
          name: 'createContentApiRoutes',
          impl: async () => obj({ type: async () => ({ k: 'str', v: 'content-api' }), routes }),
        };
      },
    }),
  });
  // Every other export of @strapi/utils is unknown to us.
  m.open = true;
  return m;
}

/** Every argument as a string, or `undefined` when one isn't known to be one. */
function strings(args: Value[]): string[] | undefined {
  const out: string[] = [];
  for (const a of args) {
    if (a.k !== 'str') return undefined;
    out.push(a.v);
  }
  return out;
}

/**
 * Node's `path` → `join` and `resolve` of strings (`path.join(__dirname, 'server')`),
 * the `.`/`..` segments resolved. `resolve` needs an absolute part: the working
 * directory is unknown here.
 */
function pathModule(): ObjValue {
  const m = obj({
    join: async () => ({
      k: 'native',
      name: 'path.join',
      impl: async (args) => {
        const parts = strings(args);
        return parts ? { k: 'str', v: resolveDots(join(...parts)) } : UNKNOWN('path.join of a non-string');
      },
    }),
    resolve: async () => ({
      k: 'native',
      name: 'path.resolve',
      impl: async (args) => {
        const parts = strings(args);
        if (!parts) return UNKNOWN('path.resolve of a non-string');
        let from = -1;
        for (let i = parts.length - 1; i >= 0 && from < 0; i--) if (isAbsolute(parts[i]!)) from = i;
        return from < 0 ? UNKNOWN('path.resolve from the working directory') : { k: 'str', v: resolveDots(join(...parts.slice(from))) };
      },
    }),
  });
  m.open = true;
  return m;
}

/**
 * Node's `fs` → `existsSync(path)`, answered from the disk: `true` when the file
 * or folder is there. Absent, it stays unknown — a build (TypeScript's `dist`)
 * may hold what the sources don't. A TypeScript source stays unknown too: once
 * compiled, the code runs from `dist`, where it isn't.
 */
function fsModule(ev: StaticEvaluator): ObjValue {
  const m = obj({
    existsSync: async () => ({
      k: 'native',
      name: 'fs.existsSync',
      impl: async ([p]) => {
        if (p?.k !== 'str' || !isAbsolute(p.v)) return UNKNOWN('fs.existsSync of a path not read');
        if (/\.[cm]?tsx?$/.test(p.v) && !p.v.endsWith('.d.ts')) return UNKNOWN('fs.existsSync of a TypeScript source (gone once compiled)');
        return (await ev.pathExists(p.v)) ? { k: 'bool', v: true } : UNKNOWN('fs.existsSync: not here (a build may add it)');
      },
    }),
  });
  m.open = true;
  return m;
}

/** External-module models for the plugin evaluator. */
export function strapiExternals(spec: string, ev: StaticEvaluator): Value | undefined {
  if (spec === '@strapi/utils') return utilsModule(ev);
  if (spec === 'path' || spec === 'node:path') return pathModule();
  if (spec === 'fs' || spec === 'node:fs') return fsModule(ev);
  return undefined;
}
