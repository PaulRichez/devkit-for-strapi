'use strict';

const { createCoreController } = require('@strapi/strapi').factories;

module.exports = createCoreController('api::article.article', ({ strapi }) => ({
  async find(ctx) {
    const entries = await strapi.entityService.findMany('api::article.article', {
      populate: { category: true },
    });
    ctx.body = entries;
  },

  async byCategory(ctx) {
    ctx.body = await strapi.db.query('api::article.article').findMany({});
  },
}));
