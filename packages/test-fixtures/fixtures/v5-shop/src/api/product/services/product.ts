import { factories } from '@strapi/strapi';

export default factories.createCoreService('api::product.product', ({ strapi }) => ({
  async findFeatured() {
    return strapi.documents('api::product.product').findMany({
      filters: { featured: true },
    });
  },
}));
