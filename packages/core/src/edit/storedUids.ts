/**
 * Refactors edit code and files — but Strapi also stores some UIDs, as strings,
 * in the database of a project that already has data. Renaming or moving one of
 * them leaves those rows pointing at the old UID: roles lose permissions, media
 * and components get detached, with no error. These warnings say so, precisely,
 * on every plan that changes such a UID (checked against Strapi 4.13 and 5.48).
 */

import type { StrapiIndex } from '../model/types';

export type RefKind = 'content-type' | 'component' | 'controller' | 'service' | 'policy' | 'middleware';

/** What kind of entity `ref` is in this index (undefined: not indexed). */
export function refKind(index: StrapiIndex, ref: string): RefKind | undefined {
  if (index.contentTypes.has(ref)) return 'content-type';
  if (index.components.has(ref)) return 'component';
  if (index.controllers.has(ref)) return 'controller';
  if (index.services.has(ref)) return 'service';
  if (index.policies.has(ref)) return 'policy';
  if (index.middlewares.has(ref)) return 'middleware';
  return undefined;
}

export interface UidChange {
  kind: RefKind;
  from: string;
  to: string;
}

/** A controller action renamed (`api::x.x.find` → `api::x.x.search`). */
export interface ActionChange {
  from: string;
  to: string;
}

const AFTER =
  'This plan only edits code and files: on a project that already has data (a dev or production database), migrate those rows after deploying, or re-grant the permissions / re-link the content by hand.';

/** The database caveats of a refactor (empty when nothing it changes is stored in the database). */
export function storedUidWarnings(change: { uids?: readonly UidChange[]; actions?: readonly ActionChange[] }): string[] {
  const out: string[] = [];
  for (const c of change.uids ?? []) {
    if (c.from === c.to) continue;
    if (c.kind === 'content-type') {
      out.push(
        `Database: Strapi stores the UID \`${c.from}\` in the database — roles' permissions (users-permissions \`up_permissions.action\`, e.g. \`${c.from}.find\`; admin \`admin_permissions.subject\`; API-token permissions), the media library's links to its entries (upload \`related_type\`), its content-manager view settings (\`strapi_core_store_settings\`) and, in Strapi 5, release actions. After the rename to \`${c.to}\` those rows still point at \`${c.from}\`. ${AFTER}`,
      );
    } else if (c.kind === 'component') {
      out.push(
        `Database: entries store their components by UID (\`component_type\` in the component and dynamic-zone join tables), and the content-manager keeps view settings per component (\`strapi_core_store_settings\`). Until those rows go from \`${c.from}\` to \`${c.to}\`, existing entries lose these components. ${AFTER}`,
      );
    } else if (c.kind === 'controller') {
      out.push(
        `Database: route permissions are stored by action (\`${c.from}.<action>\`) in users-permissions \`up_permissions\` and in API-token permissions. After the move to \`${c.to}\`, roles and tokens lose access to these routes. ${AFTER}`,
      );
    }
  }
  for (const a of change.actions ?? []) {
    if (a.from === a.to) continue;
    out.push(
      `Database: route permissions are stored by action in users-permissions \`up_permissions\` and in API-token permissions: roles and tokens granted \`${a.from}\` lose access to \`${a.to}\` until it is re-granted or the rows are migrated. ${AFTER}`,
    );
  }
  return [...new Set(out)];
}

/** The UID a ref gets when its last segment is renamed (`api::a.a` + `b` → `api::a.b`, `shared.seo` + `x` → `shared.x`). */
export function renamedUid(ref: string, newName: string): string {
  return ref.slice(0, ref.lastIndexOf('.') + 1) + newName;
}

/** The UID a ref gets when moved to `toNamespace` (`api::x.helper` → `plugin::dst.helper`). */
export function movedUid(ref: string, toNamespace: string): string {
  return `${toNamespace}.${ref.slice(ref.lastIndexOf('.') + 1)}`;
}
