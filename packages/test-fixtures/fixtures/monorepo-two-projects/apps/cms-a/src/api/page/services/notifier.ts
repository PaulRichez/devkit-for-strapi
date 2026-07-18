// A fully custom service — NOT a createCoreService override.
// Strapi registers it by file name → ref `api::page.notifier`.
export default ({ strapi }: { strapi: any }) => ({
  async notify(message: string) {
    strapi.log.info(message);
    return true;
  },
});
