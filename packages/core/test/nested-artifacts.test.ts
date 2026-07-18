import { beforeAll, describe, expect, it } from 'vitest';
import { createEngine, type StrapiEngine } from '../src/engine';
import { MemoryFileSystem } from '../src/fs/MemoryFileSystem';
import type { StrapiProject } from '../src/model/types';
import { dependencies, dependents, listRefs } from '../src/query/graph';
import { resolveRef, validateRef } from '../src/query/refQuery';

// A plugin with a service in a SUB-FOLDER (dotted name) calling a top-level one.
const R = 'c:/n';
const files: Record<string, string> = {
  [`${R}/package.json`]: '{"dependencies":{"@strapi/strapi":"^5.0.0"}}',
  [`${R}/src/plugins/comms/server/services/email.js`]: 'export default { send() { return 1; } };\n',
  [`${R}/src/plugins/comms/server/services/mailer/queue.js`]:
    `export default { run() { return strapi.plugin('comms').service('email').send(); } };\n`,
};

describe('nested (dotted-name) artifacts are indexed and graphed', () => {
  let engine: StrapiEngine;
  let project: StrapiProject;
  beforeAll(async () => {
    engine = createEngine(new MemoryFileSystem(files));
    await engine.init([R]);
    await engine.whenReferencesReady();
    project = engine.allProjects()[0]!;
  });

  it('indexes a sub-folder service under its dotted ref', () => {
    expect(validateRef(project, 'plugin::comms.mailer.queue').status).toBe('valid');
    const targets = resolveRef(project, 'plugin::comms.mailer.queue');
    expect(targets.some((t) => t.kind === 'service' && t.filePath.endsWith('mailer/queue.js'))).toBe(true);
  });

  it('lists the nested ref in the plugin surface (glob)', () => {
    const refs = listRefs(project, 'plugin::comms.*').map((r) => r.ref);
    expect(refs).toContain('plugin::comms.mailer.queue');
    expect(refs).toContain('plugin::comms.email');
  });

  it('graphs the nested service both ways (the cut-analysis is now honest)', () => {
    expect(dependencies(project, 'plugin::comms.mailer.queue')).toContain('plugin::comms.email');
    expect(dependents(project, 'plugin::comms.email')).toContain('plugin::comms.mailer.queue');
  });
});
