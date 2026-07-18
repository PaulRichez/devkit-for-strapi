import { factories } from '@strapi/strapi';

export default factories.createCoreRouter('api::product.product', {
  config: {
    find: {
      policies: ['global::is-authenticated'],
      middlewares: [],
    },
  },
});
