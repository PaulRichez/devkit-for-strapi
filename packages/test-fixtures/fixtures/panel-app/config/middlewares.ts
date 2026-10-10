export default [
  'strapi::errors',
  { name: 'strapi::cors', config: { origin: ['*'] } },
  'global::request-id',
  'request-id',
];
