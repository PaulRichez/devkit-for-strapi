import { factories } from '@strapi/strapi';

export default factories.createCoreController('api::article.article', () => ({
  async find(ctx) {
    return super.find(ctx);
  },
  async publish(ctx) {
    ctx.body = { ok: true };
  },
}));
