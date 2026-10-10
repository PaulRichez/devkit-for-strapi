export default {
  routes: [
    {
      method: 'POST',
      path: '/articles/:id/publish',
      handler: 'article.publish',
      config: { policies: ['is-owner'], middlewares: ['global::audit'] },
    },
  ],
};
