import { factories } from '@strapi/strapi';

export default factories.createCoreService('api::page.page', ({ strapi }) => ({
  async findPage(documentId: string) {
    return strapi.documents('api::page.page').findOne({ documentId });
  },
}));
