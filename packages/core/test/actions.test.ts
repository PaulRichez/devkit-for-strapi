import { describe, expect, it } from 'vitest';
import { extractControllerActions } from '../src/index/actions';

describe('controller action extraction', () => {
  it('extracts methods from a factory controller (arrow returning object)', () => {
    const text = `import { factories } from '@strapi/strapi';
export default factories.createCoreController('api::x.x', ({ strapi }) => ({
  async find(ctx) {},
  custom(ctx) {},
}));`;
    const actions = extractControllerActions('c.ts', text).map((a) => a.name).sort();
    expect(actions).toEqual(['custom', 'find']);
  });

  it('extracts methods from a bare default-export object', () => {
    const text = `export default {
  async findOne(ctx) {},
  update(ctx) {},
};`;
    const actions = extractControllerActions('c.ts', text).map((a) => a.name).sort();
    expect(actions).toEqual(['findOne', 'update']);
  });

  it('returns no actions for a core controller without overrides', () => {
    const text = `const { createCoreController } = require('@strapi/strapi').factories;
module.exports = createCoreController('api::x.x');`;
    expect(extractControllerActions('c.js', text)).toEqual([]);
  });

  it('records a usable offset for each action', () => {
    const text = `export default factories.createCoreController('api::x.x', () => ({ find(ctx) {} }));`;
    const [find] = extractControllerActions('c.ts', text);
    expect(find!.name).toBe('find');
    expect(text.slice(find!.offset)).toMatch(/^find/);
  });
});
