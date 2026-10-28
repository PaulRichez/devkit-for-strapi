import { describe, expect, it } from 'vitest';
import { createEngine } from '../src/engine';
import { MemoryFileSystem } from '../src/fs/MemoryFileSystem';
import type { StrapiProject } from '../src/model/types';
import { listBrokenRefs, listUnused, referencesOf, unresolvedCallsOf, validateRef } from '../src/query/refQuery';

// What a review of the feedback-v2 changes found: each case fails without its fix.
const R = 'c:/fa';
const ct = (name: string) => `{"kind":"collectionType","info":{"singularName":"${name}","pluralName":"${name}s"},"attributes":{}}`;

async function open(files: Record<string, string>): Promise<{ fs: MemoryFileSystem; engine: ReturnType<typeof createEngine>; project: () => StrapiProject }> {
  const fs = new MemoryFileSystem({ [`${R}/package.json`]: '{"dependencies":{"@strapi/strapi":"^4.0.0"}}', ...files });
  const engine = createEngine(fs);
  await engine.init([R]);
  await engine.whenReferencesReady();
  return { fs, engine, project: () => engine.allProjects()[0]! };
}

describe('weak literals follow definition changes (incremental = full build)', () => {
  const files = {
    [`${R}/src/api/old/content-types/old/schema.json`]: ct('old'),
    [`${R}/src/api/keep/content-types/keep/schema.json`]: ct('keep'),
    [`${R}/src/index.js`]: "const TARGETS = { a: 'api::old.old', n: 'api::neo.neo' };\nmodule.exports = { register() {}, TARGETS };\n",
  };

  it('a UID value whose entity is deleted is not a broken ref', async () => {
    const { fs, engine, project } = await open(files);
    expect(referencesOf(project(), 'api::old.old').map((l) => l.via)).toEqual(['literal']);
    const schema = `${R}/src/api/old/content-types/old/schema.json`;
    fs.delete(schema);
    await engine.onFilesChanged([], [schema]);
    expect(listBrokenRefs(project())).toEqual([]);
    expect(referencesOf(project(), 'api::old.old')).toEqual([]);
  });

  it('an entity added under a UID a value already holds is not listed unused', async () => {
    const { fs, engine, project } = await open(files);
    const schema = `${R}/src/api/neo/content-types/neo/schema.json`;
    fs.writeFile(schema, ct('neo'));
    await engine.onFilesChanged([schema], []);
    expect(listUnused(project(), { kinds: ['content-type'] }).map((u) => u.ref)).toEqual(['api::keep.keep']);
    expect(referencesOf(project(), 'api::neo.neo').map((l) => l.via)).toEqual(['literal']);
  });

  it('a file that no longer holds the value drops its weak reference', async () => {
    const { fs, engine, project } = await open(files);
    fs.writeFile(`${R}/src/index.js`, 'module.exports = { register() {} };\n');
    await engine.onFilesChanged([`${R}/src/index.js`], []);
    expect(referencesOf(project(), 'api::old.old')).toEqual([]);
    fs.delete(`${R}/src/index.js`);
    await engine.onFilesChanged([], [`${R}/src/index.js`]);
    const schema = `${R}/src/api/neo/content-types/neo/schema.json`;
    fs.writeFile(schema, ct('neo'));
    await engine.onFilesChanged([schema], []);
    expect(referencesOf(project(), 'api::neo.neo')).toEqual([]);
  });
});

describe('names the folder convention only guessed', () => {
  it('a name a helper registers differently is the helper\'s, never the folder\'s guess', async () => {
    const { project } = await open({
      [`${R}/src/plugins/helper/package.json`]: '{"name":"helper","strapi":{"kind":"plugin","name":"helper"}}',
      [`${R}/src/plugins/helper/strapi-server.js`]: "module.exports = require('./server');\n",
      [`${R}/src/plugins/helper/server/index.js`]: "module.exports = { services: require('./services') };\n",
      [`${R}/src/plugins/helper/server/services/index.js`]: [
        'const withPrefix = (prefix, services) => Object.keys(services).reduce((acc, key) => {',
        '  acc[`${prefix}.${key}`] = services[key];',
        '  return acc;',
        '}, {});',
        "module.exports = { email: require('./email'), ...withPrefix('error', require('./error')) };",
        '',
      ].join('\n'),
      [`${R}/src/plugins/helper/server/services/email.js`]: 'module.exports = ({ strapi }) => ({ send() {} });\n',
      [`${R}/src/plugins/helper/server/services/error/index.js`]: "module.exports = { catch: require('./catch') };\n",
      [`${R}/src/plugins/helper/server/services/error/catch.js`]: 'module.exports = ({ strapi }) => ({ run() {} });\n',
      [`${R}/config/plugins.js`]: "module.exports = { helper: { enabled: true, resolve: './src/plugins/helper' } };\n",
    });
    expect(validateRef(project(), 'plugin::helper.email').status).toBe('valid');
    // Strapi registers `error.catch`, never `error`: the helper is read exactly (v2 #18), so DevKit
    // says it — the helper's own names valid, the folder's guess unknown. (An opaque helper: loader-parity.)
    expect(validateRef(project(), 'plugin::helper.error.catch').status).toBe('valid');
    expect(validateRef(project(), 'plugin::helper.error').status).toBe('unknown');
    expect(validateRef(project(), 'plugin::helper.error', 'service').status).toBe('unknown');
  });
});

describe('a typed string constant', () => {
  it('is followed whether or not another const of the file is untyped', async () => {
    const { project } = await open({
      [`${R}/src/api/k/content-types/k/schema.json`]: ct('k'),
      [`${R}/src/api/k/services/use.ts`]: "const UID: string = 'api::k.k';\nexport default ({ strapi }) => ({ run() { return strapi.service(UID); } });\n",
    });
    expect(referencesOf(project(), 'api::k.k').map((l) => l.via)).toContain('service');
    expect(unresolvedCallsOf(project(), ['service'])).toEqual([]);
  });
});

describe('a batch of changes in a local plugin', () => {
  class CountingFs extends MemoryFileSystem {
    reads = 0;
    override async readFile(path: string): Promise<string> {
      this.reads++;
      return super.readFile(path);
    }
  }
  const N = 40;
  const files = (): Record<string, string> => {
    const out: Record<string, string> = {
      [`${R}/package.json`]: '{"dependencies":{"@strapi/strapi":"^4.0.0"}}',
      [`${R}/config/plugins.js`]: "module.exports = { p: { enabled: true, resolve: './src/plugins/p' } };\n",
      [`${R}/src/plugins/p/package.json`]: '{"name":"p","strapi":{"kind":"plugin","name":"p"}}',
      [`${R}/src/plugins/p/strapi-server.js`]: "module.exports = require('./server');\n",
      [`${R}/src/plugins/p/server/index.js`]: "module.exports = { services: require('./services') };\n",
      [`${R}/src/plugins/p/admin/src/index.jsx`]: 'export default {};\n',
    };
    const keys: string[] = [];
    for (let i = 0; i < N; i++) {
      out[`${R}/src/plugins/p/server/services/s${i}.js`] = 'module.exports = ({ strapi }) => ({ run() {} });\n';
      keys.push(`s${i}: require('./s${i}')`);
    }
    out[`${R}/src/plugins/p/server/services/index.js`] = `module.exports = { ${keys.join(', ')} };\n`;
    return out;
  };

  it('re-reads the plugin once, not once per file; its admin code not at all', async () => {
    const fs = new CountingFs(files());
    const engine = createEngine(fs);
    await engine.init([R]);
    await engine.whenReferencesReady();
    const changed = Array.from({ length: N }, (_, i) => `${R}/src/plugins/p/server/services/s${i}.js`);
    fs.reads = 0;
    await engine.onFilesChanged(changed, []);
    // One registry read of the plugin (~N files) plus the N references re-read — never ~N².
    expect(fs.reads).toBeLessThan(4 * N);
    expect(validateRef(engine.allProjects()[0]!, `plugin::p.s${N - 1}`).status).toBe('valid');
    fs.reads = 0;
    await engine.onFilesChanged([`${R}/src/plugins/p/admin/src/index.jsx`], []);
    expect(fs.reads).toBeLessThan(5);
  });
});

describe('a readdir elsewhere in a plugin', () => {
  it("doesn't make a collection built by an unknown helper a verified folder convention", async () => {
    const { project } = await open({
      [`${R}/src/plugins/pkg/package.json`]: '{"name":"pkg","strapi":{"kind":"plugin","name":"pkg"}}',
      [`${R}/src/plugins/pkg/strapi-server.js`]: "module.exports = require('./server');\n",
      [`${R}/src/plugins/pkg/server/index.js`]: [
        "const fs = require('fs'); const path = require('path');",
        "const { loadServices } = require('@acme/strapi-utils');",
        'module.exports = {',
        "  bootstrap({ strapi }) { for (const f of fs.readdirSync(path.join(__dirname, 'seeds'))) strapi.log.info(f); },",
        "  services: loadServices(path.join(__dirname, 'services')),",
        '};',
        '',
      ].join('\n'),
      [`${R}/src/plugins/pkg/server/services/my-thing.js`]: 'module.exports = ({ strapi }) => ({ go() {} });\n',
      [`${R}/src/api/a/content-types/a/schema.json`]: ct('a'),
      [`${R}/src/api/a/services/a.js`]: "module.exports = ({ strapi }) => ({ run() { return strapi.service('plugin::pkg.myThing').go(); } });\n",
      [`${R}/config/plugins.js`]: "module.exports = { pkg: { enabled: true, resolve: './src/plugins/pkg' } };\n",
    });
    expect(validateRef(project(), 'plugin::pkg.myThing').status).toBe('external');
    expect(listBrokenRefs(project())).toEqual([]);
  });
});
