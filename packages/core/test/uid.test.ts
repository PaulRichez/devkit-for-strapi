import { describe, expect, it } from 'vitest';
import {
  buildArtifactRef,
  buildComponentUid,
  buildContentTypeUid,
  isWellFormedEntityUid,
  parseAddress,
  parseComponentUid,
  parseRef,
} from '../src/model/uid';

describe('uid', () => {
  it('parses entity refs', () => {
    expect(parseRef('api::blog.article')).toEqual({ namespace: 'api', scope: 'blog', name: 'article' });
    expect(parseRef('api::blog.article.find')).toEqual({
      namespace: 'api',
      scope: 'blog',
      name: 'article',
      action: 'find',
    });
    expect(parseRef('plugin::users-permissions.user')).toEqual({
      namespace: 'plugin',
      scope: 'users-permissions',
      name: 'user',
    });
    expect(parseRef('global::is-auth')).toEqual({ namespace: 'global', scope: '', name: 'is-auth' });
  });

  it('rejects malformed refs', () => {
    expect(parseRef('garbage')).toBeNull();
    expect(parseRef('api::blog')).toBeNull();
    expect(parseRef('global::a.b')).toBeNull();
    expect(parseRef('weird::a.b')).toBeNull();
  });

  it('builds refs and uids', () => {
    expect(buildContentTypeUid('blog', 'article')).toBe('api::blog.article');
    expect(buildComponentUid('shared', 'seo')).toBe('shared.seo');
    expect(buildArtifactRef('api', 'article', { apiName: 'blog' })).toBe('api::blog.article');
    expect(buildArtifactRef('global', 'is-auth')).toBe('global::is-auth');
    expect(buildArtifactRef('plugin', 'user', { pluginName: 'users-permissions' })).toBe(
      'plugin::users-permissions.user',
    );
  });

  it('parses a unified address with an optional #method', () => {
    expect(parseAddress('api::blog.article')).toEqual({ ref: 'api::blog.article' });
    expect(parseAddress('api::blog.article#notify')).toEqual({ ref: 'api::blog.article', method: 'notify' });
    expect(parseAddress('shared.seo')).toEqual({ ref: 'shared.seo' });
    expect(parseAddress('api::blog.article#')).toEqual({ ref: 'api::blog.article' }); // empty method ignored
  });

  it('parses and validates component uids and entity uids', () => {
    expect(parseComponentUid('shared.seo')).toEqual({ category: 'shared', name: 'seo' });
    expect(parseComponentUid('bad')).toBeNull();
    expect(parseComponentUid('a.b.c')).toBeNull();
    expect(isWellFormedEntityUid('api::blog.article')).toBe(true);
    expect(isWellFormedEntityUid('global::x')).toBe(false);
    expect(isWellFormedEntityUid('api::blog.article.find')).toBe(false);
  });
});
