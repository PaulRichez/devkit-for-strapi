import { factories } from '@strapi/strapi';

export default factories.createCoreController('api::item.item', ({ strapi }) => ({
  async find(ctx) {
    ctx.body = await strapi.documents('api::item.item').findMany({});
  },
}));
