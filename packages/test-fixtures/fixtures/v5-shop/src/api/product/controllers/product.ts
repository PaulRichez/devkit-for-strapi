import { factories } from '@strapi/strapi';

export default factories.createCoreController('api::product.product', ({ strapi }) => ({
  async find(ctx) {
    const products = await strapi.documents('api::product.product').findMany({});
    ctx.body = products;
  },

  async featured(ctx) {
    ctx.body = await strapi.service('api::product.product').findFeatured();
  },
}));
