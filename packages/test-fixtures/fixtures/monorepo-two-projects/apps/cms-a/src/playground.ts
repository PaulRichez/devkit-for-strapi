/*
 * Strapi DevKit playground (cms-a — a Strapi v5 project).
 *
 * Open this file in the Extension Development Host (F5) and try:
 *   • Hover a magic string  → Strapi DevKit shows what it resolved to.
 *   • Ctrl/Cmd + Click      → jump to schema.json / service / action.
 *   • Type inside the quotes → autocomplete of real references.
 *   • Watch the squiggles    → diagnostics + quick fixes on the typos below.
 *
 * (Hover over the JS methods like `findMany` shows `any` — that's the TypeScript
 *  server, not Strapi DevKit: this fixture has no @strapi/strapi types installed.)
 */
declare const strapi: any;

export async function demo() {
  // ✅ content-type — Ctrl+Click jumps to content-types/page/schema.json
  await strapi.documents('api::page.page').findMany({});

  // ✅ second content-type in the SAME api (proves multi-schema-per-api)
  await strapi.documents('api::page.section').findMany({});

  // ✅ service (core override) — Ctrl+Click jumps to services/page.ts
  await strapi.service('api::page.page').findPage('abc');

  // ✅ CUSTOM service (not a factory override) — jumps to services/notifier.ts
  await strapi.service('api::page.notifier').notify('hi');

  // ✅ controller action — jumps to the `find` method
  // (used in a route handler string, see routes below)

  // ❌ typo — diagnostic + quick fix suggests 'api::page.page'
  await strapi.documents('api::page.pag').findMany({});

  // ❌ unknown service — quick fix suggests 'api::page.page'
  strapi.service('api::page.pag');

  // ⚠️ v4 pattern inside a v5 project — diagnostic
  await strapi.entityService.findMany('api::page.page', {});
}

export const routes = {
  routes: [
    // ✅ valid handler — Ctrl+Click jumps to the controller's `find` method
    { method: 'GET', path: '/pages', handler: 'api::page.page.find' },
    // ✅ CUSTOM controller action — jumps to controllers/webhook.ts `receive`
    { method: 'POST', path: '/pages/hook', handler: 'api::page.webhook.receive' },
    // ❌ unknown action — quick fix suggests a known one
    { method: 'GET', path: '/pages/x', handler: 'api::page.page.finde' },
  ],
};
