import { normalize } from '../fs/paths';
import type {
  ComponentInsights,
  ContentTypeInsights,
  StrapiProject,
} from '../model/types';

/** Pre-computed lookups for the insight functions (built once per project). */
export interface ModelMaps {
  /** normalize(schemaPath).toLowerCase() → content-type uid */
  schemaPathToUid: Map<string, string>;
  /** normalize(jsonPath).toLowerCase() → component uid */
  jsonPathToComponentUid: Map<string, string>;
  /** controller ref (`ns::scope.name`) → number of route-handler references */
  routeHandlerCounts: Map<string, number>;
}

const norm = (p: string): string => normalize(p).toLowerCase();

/** Build the reverse-maps + route-handler counts in a single pass over the index. */
export function buildModelMaps(project: StrapiProject): ModelMaps {
  const schemaPathToUid = new Map<string, string>();
  for (const ct of project.index.contentTypes.values()) schemaPathToUid.set(norm(ct.schemaPath), ct.uid);

  const jsonPathToComponentUid = new Map<string, string>();
  for (const c of project.index.components.values()) jsonPathToComponentUid.set(norm(c.jsonPath), c.uid);

  // Route handlers share the `method:` key space with member calls; only the
  // `via:'route'` ones are real HTTP routes. Group them by their controller ref.
  const routeHandlerCounts = new Map<string, number>();
  for (const [key, locs] of project.references) {
    if (!key.startsWith('method:')) continue;
    const rest = key.slice('method:'.length); // `ns::scope.name.action`
    const lastDot = rest.lastIndexOf('.');
    if (lastDot < 0) continue;
    const controllerRef = rest.slice(0, lastDot);
    const n = locs.reduce((acc, l) => acc + (l.via === 'route' ? 1 : 0), 0);
    if (n) routeHandlerCounts.set(controllerRef, (routeHandlerCounts.get(controllerRef) ?? 0) + n);
  }

  return { schemaPathToUid, jsonPathToComponentUid, routeHandlerCounts };
}

/** Usage breakdown for a content-type: total, incoming relations, routes, data. */
export function contentTypeInsights(
  project: StrapiProject,
  uid: string,
  maps: ModelMaps,
): ContentTypeInsights {
  const refs = project.references.get(`ct:${uid}`) ?? [];
  const incomingRelations: ContentTypeInsights['incomingRelations'] = [];
  let dataUsages = 0;
  for (const r of refs) {
    if (r.via === 'schema') {
      const fromUid = maps.schemaPathToUid.get(norm(r.filePath));
      if (fromUid && fromUid !== uid) {
        incomingRelations.push({ fromUid, filePath: r.filePath, line: r.start.line });
      }
    } else {
      dataUsages++;
    }
  }
  return {
    total: refs.length,
    incomingRelations,
    routeHandlers: maps.routeHandlerCounts.get(uid) ?? 0,
    dataUsages,
  };
}

/** Which content-types/components use this component. */
export function componentInsights(
  project: StrapiProject,
  uid: string,
  maps: ModelMaps,
): ComponentInsights {
  const refs = project.references.get(`component:${uid}`) ?? [];
  const used = new Set<string>();
  for (const r of refs) {
    if (r.via !== 'schema') continue;
    const f = norm(r.filePath);
    const fromUid = maps.schemaPathToUid.get(f) ?? maps.jsonPathToComponentUid.get(f);
    if (fromUid) used.add(fromUid);
  }
  return { usedInContentTypes: [...used], usedByCount: refs.length };
}
