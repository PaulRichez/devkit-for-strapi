import { loadFixture } from 'devkit-for-strapi-test-fixtures';
import { beforeAll, describe, expect, it } from 'vitest';
import { createEngine, type StrapiEngine } from '../src/engine';
import { MemoryFileSystem } from '../src/fs/MemoryFileSystem';

describe('built-in Strapi API method hover', () => {
  let engine: StrapiEngine;
  let root: string;
  const file = (): string => `${root}/src/api/product/controllers/x.ts`;
  const hoverAt = (code: string, needle: string) =>
    engine.getHover(file(), code.indexOf(needle) + 1, code);

  beforeAll(async () => {
    const fx = loadFixture('v5-shop');
    root = fx.root;
    engine = createEngine(new MemoryFileSystem(fx.files));
    await engine.init([root]);
  });

  it('describes a Document Service method with its target and docs link', async () => {
    const info = await hoverAt(`strapi.documents('api::product.product').findMany({})`, 'findMany');
    expect(info?.markdown).toContain('Document Service');
    expect(info?.markdown).toContain('findMany');
    expect(info?.markdown).toContain('api::product.product');
    expect(info?.markdown).toContain('docs.strapi.io');
  });

  it('describes an Entity Service method', async () => {
    const info = await hoverAt(`strapi.entityService.findOne('api::product.product', 1)`, 'findOne');
    expect(info?.markdown).toContain('Entity Service');
    expect(info?.markdown).toContain('api::product.product');
  });

  it('describes a Query Engine method', async () => {
    const info = await hoverAt(`strapi.db.query('api::product.product').findWithCount({})`, 'findWithCount');
    expect(info?.markdown).toContain('Query Engine');
  });

  it('does not guess unknown methods', async () => {
    const info = await hoverAt(`strapi.documents('api::product.product').frobnicate()`, 'frobnicate');
    expect(info).toBeUndefined();
  });
});
