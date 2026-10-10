/**
 * Refactors that change a UID Strapi also stores in the database (permissions,
 * media links, components) say so; the others stay quiet.
 */
import { describe, expect, it } from 'vitest';
import { movedUid, renamedUid, storedUidWarnings } from '../src/edit/storedUids';

describe('database caveats of a refactor', () => {
  it('a content-type: permissions, media links, view settings', () => {
    const [w, ...rest] = storedUidWarnings({ uids: [{ kind: 'content-type', from: 'api::article.article', to: 'api::article.post' }] });
    expect(rest).toEqual([]);
    for (const s of ['up_permissions', 'admin_permissions', 'related_type', 'strapi_core_store_settings', 'api::article.article.find', 'api::article.post']) expect(w).toContain(s);
  });
  it('a component: component_type', () => {
    expect(storedUidWarnings({ uids: [{ kind: 'component', from: 'shared.seo', to: 'shared.meta' }] })[0]).toContain('component_type');
  });
  it('a controller or a controller action: route permissions', () => {
    expect(storedUidWarnings({ uids: [{ kind: 'controller', from: 'api::x.helper', to: 'plugin::dst.helper' }] })[0]).toContain('up_permissions');
    expect(storedUidWarnings({ actions: [{ from: 'api::x.x.find', to: 'api::x.x.search' }] })[0]).toContain('api::x.x.find');
  });
  it('services, policies, middlewares and no-op changes: nothing', () => {
    expect(
      storedUidWarnings({
        uids: [
          { kind: 'service', from: 'api::x.a', to: 'api::x.b' },
          { kind: 'policy', from: 'global::a', to: 'global::b' },
          { kind: 'middleware', from: 'global::m', to: 'global::n' },
          { kind: 'content-type', from: 'api::x.x', to: 'api::x.x' },
        ],
      }),
    ).toEqual([]);
  });
  it('the new UIDs', () => {
    expect(renamedUid('api::product.product', 'item')).toBe('api::product.item');
    expect(renamedUid('shared.seo', 'meta')).toBe('shared.meta');
    expect(movedUid('api::x.helper', 'plugin::dst')).toBe('plugin::dst.helper');
  });
});
