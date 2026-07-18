// A fully custom controller — NOT a createCoreController override.
// Strapi registers it by file name → ref `api::page.webhook`, action `receive`.
export default {
  async receive(ctx: any) {
    ctx.body = 'ok';
  },
};
