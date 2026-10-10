/**
 * Models of the few framework helpers Strapi plugins call while *declaring* their
 * server parts. Evaluating `@strapi/utils` itself would mean walking a large
 * dependency graph; these helpers are tiny and stable, so DevKit models them
 * exactly (each model cites the source it mirrors). Anything not modelled stays
 * `unknown` — the plugin is then reported incomplete, never guessed.
 */

import { isCallable, type ObjValue, type StaticEvaluator, UNKNOWN, type Value } from './evaluate';

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
        let shared: Promise<Value> | undefined;
        const routes = (): Promise<Value> => (shared ??= ev.call(build, []));
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

/** External-module models for the plugin evaluator. */
export function strapiExternals(spec: string, ev: StaticEvaluator): Value | undefined {
  if (spec === '@strapi/utils') return utilsModule(ev);
  return undefined;
}
