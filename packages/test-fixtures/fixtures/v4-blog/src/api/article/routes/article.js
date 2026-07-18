'use strict';

const { createCoreRouter } = require('@strapi/strapi').factories;

module.exports = createCoreRouter('api::article.article', {
  config: {
    find: {
      policies: ['global::is-owner', 'api::article.is-published'],
      middlewares: [],
    },
  },
});
