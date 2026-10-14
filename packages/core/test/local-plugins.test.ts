import { describe, expect, it } from 'vitest';
import { createEngine } from '../src/engine';
import { MemoryFileSystem } from '../src/fs/MemoryFileSystem';
import { validateRef } from '../src/query/refQuery';
import { discoverProjectRoots, findStrapiRootUp } from '../src/workspace/discovery';

const ROOT = '/app';
const PLUGIN = `${ROOT}/src/plugins/media-tools`;

/** A v5 app with a local plugin scaffolded by the Strapi 5 plugin SDK (`server/src`, own package.json). */
function app(extra: Record<string, string> = {}): MemoryFileSystem {
  return new MemoryFileSystem({
    [`${ROOT}/package.json`]: JSON.stringify({ dependencies: { '@strapi/strapi': '5.10.0' } }),
    [`${ROOT}/config/plugins.ts`]: `export default { 'media-tools': { enabled: true, resolve: 'src/plugins/media-tools' } };`,
    [`${PLUGIN}/package.json`]: JSON.stringify({
      name: 'media-tools',
      strapi: { kind: 'plugin', name: 'media-tools' },
      devDependencies: { '@strapi/strapi': '^5.10.0' },
    }),
    [`${PLUGIN}/server/src/services/index.ts`]: `import unused from './unused';\nexport default { unused };`,
    [`${PLUGIN}/server/src/services/unused.ts`]: `export default ({ strapi }) => ({ list() {} });`,
    [`${PLUGIN}/server/src/content-types/index.ts`]: `const ignoredEntry = {
  schema: {
    kind: 'collectionType',
    collectionName: 'ignored_entries',
    info: { singularName: 'ignored-entry', pluralName: 'ignored-entries', displayName: 'Ignored entry' },
    attributes: { targetType: { type: 'enumeration', enum: ['file', 'folder'] } },
  },
};
export default { 'ignored-entry': ignoredEntry };`,
    ...extra,
  });
}

describe('local plugins', () => {
  it('a plugin package nested in an app is not a project of its own', async () => {
    const fs = app();
    expect(await discoverProjectRoots(fs, [ROOT])).toEqual([ROOT]);
    expect(await findStrapiRootUp(fs, `${PLUGIN}/server/src/services`)).toBe(ROOT);
  });

  it('a standalone plugin repository is still discovered (no app around it)', async () => {
    const fs = new MemoryFileSystem({
      '/repo/package.json': JSON.stringify({ strapi: { kind: 'plugin', name: 'x' }, devDependencies: { '@strapi/strapi': '5.10.0' } }),
    });
    expect(await discoverProjectRoots(fs, ['/repo'])).toEqual(['/repo']);
    expect(await findStrapiRootUp(fs, '/repo/server/src')).toBe('/repo');
  });

  it('indexes the Strapi 5 plugin SDK layout (server/src) and code-defined content-types', async () => {
    const engine = createEngine(app());
    await engine.init([ROOT]);
    const project = engine.allProjects()[0]!;
    expect(validateRef(project, 'plugin::media-tools.unused').status).toBe('valid');
    expect(validateRef(project, 'plugin::media-tools.ignored-entry').status).toBe('valid');
    const typo = validateRef(project, 'plugin::media-tools.ignored-entri');
    expect(typo.status).toBe('unknown');
    // refactors never see a code-defined content-type (its schemaPath is a shared code file)
    expect(project.index.contentTypes.has('plugin::media-tools.ignored-entry')).toBe(false);
    const diags = await engine.validateFile(
      `${ROOT}/src/index.ts`,
      `export default { async bootstrap({ strapi }) { await strapi.documents('plugin::media-tools.ignored-entry').findMany(); } };`,
    );
    expect(diags).toEqual([]);
  });

  it('a v4 plugin (server/index.js) is not shadowed by an unrelated server/src folder', async () => {
    const fs = new MemoryFileSystem({
      [`${ROOT}/package.json`]: JSON.stringify({ dependencies: { '@strapi/strapi': '4.25.0' } }),
      [`${ROOT}/src/plugins/legacy/server/index.js`]: `module.exports = { services: require('./services') };`,
      // `require('./services')` needs the folder's index (Node), which registers `report`.
      [`${ROOT}/src/plugins/legacy/server/services/index.js`]: `module.exports = { report: require('./report') };`,
      [`${ROOT}/src/plugins/legacy/server/services/report.js`]: `module.exports = () => ({ run() {} });`,
      [`${ROOT}/src/plugins/legacy/server/src/notes.md.js`]: `// unrelated`,
    });
    const engine = createEngine(fs);
    await engine.init([ROOT]);
    expect(validateRef(engine.allProjects()[0]!, 'plugin::legacy.report').status).toBe('valid');
    // Without that index the registry can't be read: the name is only the folder's guess — never said valid.
    fs.delete(`${ROOT}/src/plugins/legacy/server/services/index.js`);
    await engine.onFilesChanged([], [`${ROOT}/src/plugins/legacy/server/services/index.js`]);
    expect(validateRef(engine.allProjects()[0]!, 'plugin::legacy.report').status).toBe('external');
  });

  it('stays silent on a content-type aggregator it cannot read exhaustively', async () => {
    const engine = createEngine(
      app({ [`${PLUGIN}/server/src/content-types/index.ts`]: `import extra from 'some-lib';\nexport default { ...extra };` }),
    );
    await engine.init([ROOT]);
    const project = engine.allProjects()[0]!;
    expect(validateRef(project, 'plugin::media-tools.whatever').status).toBe('external');
  });

  it('re-reads code-defined content-types when the aggregator is edited', async () => {
    const fs = app();
    const engine = createEngine(fs);
    await engine.init([ROOT]);
    const project = engine.allProjects()[0]!;
    const file = `${PLUGIN}/server/src/content-types/index.ts`;
    fs.writeFile(file, `export default { report: { schema: { kind: 'singleType', info: { singularName: 'report' }, attributes: {} } } };`);
    await engine.onFilesChanged([file], []);
    expect(validateRef(project, 'plugin::media-tools.report').status).toBe('valid');
    expect(validateRef(project, 'plugin::media-tools.ignored-entry').status).toBe('unknown');
  });
});
