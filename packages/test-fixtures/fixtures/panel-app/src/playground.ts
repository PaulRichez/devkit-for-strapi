// Opened by the integration tests.
export async function demo() {
  return strapi.documents('api::article.article').findMany({});
}
