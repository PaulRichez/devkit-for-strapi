import { factories } from '@strapi/strapi';

export default factories.createCoreController('api::page.page', ({ strapi }) => ({
  async find(ctx) {
    ctx.body = await strapi.documents('api::page.page').findMany({});
  },
}));
