export default {
  'content-api': {
    type: 'content-api',
    routes: [{ method: 'GET', path: '/items', handler: 'item.list', config: { policies: [] } }],
  },
};
