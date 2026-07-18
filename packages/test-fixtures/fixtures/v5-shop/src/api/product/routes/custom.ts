export default {
  routes: [
    {
      method: 'GET',
      path: '/products/featured',
      handler: 'api::product.product.featured',
      config: {
        policies: ['global::is-authenticated'],
        middlewares: [],
      },
    },
  ],
};
