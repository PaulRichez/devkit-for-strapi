/** Built-in Strapi data APIs — used to enrich hover on framework methods that
 * TypeScript only sees as `any` (e.g. `strapi.documents(uid).findMany`). */

export type StrapiApiId = 'document-service' | 'entity-service' | 'query-engine';

export interface StrapiApiDoc {
  label: string;
  docsUrl: string;
  methods: Record<string, string>;
}

export const STRAPI_APIS: Record<StrapiApiId, StrapiApiDoc> = {
  'document-service': {
    label: 'Document Service',
    docsUrl: 'https://docs.strapi.io/cms/api/document-service',
    methods: {
      findOne: 'Find a single document by `documentId`.',
      findFirst: 'Find the first document matching the query.',
      findMany: 'Find documents matching the query (filters, sort, pagination, populate, status, locale).',
      create: 'Create a document.',
      update: 'Update a document by `documentId`.',
      delete: 'Delete a document by `documentId`.',
      count: 'Count documents matching the query.',
      publish: 'Publish a document (Draft & Publish).',
      unpublish: 'Unpublish a document.',
      discardDraft: 'Discard the draft changes of a document.',
    },
  },
  'entity-service': {
    label: 'Entity Service (v4)',
    docsUrl: 'https://docs-v4.strapi.io/dev-docs/api/entity-service',
    methods: {
      findOne: 'Find a single entry by numeric `id`.',
      findMany: 'Find entries matching the query (filters, sort, pagination, populate).',
      create: 'Create an entry.',
      update: 'Update an entry by `id`.',
      delete: 'Delete an entry by `id`.',
      count: 'Count entries matching the query.',
    },
  },
  'query-engine': {
    label: 'Query Engine',
    docsUrl: 'https://docs.strapi.io/cms/api/query-engine',
    methods: {
      findOne: 'Low-level: find a single record.',
      findMany: 'Low-level: find records (where, orderBy, populate).',
      findWithCount: 'Low-level: find records and return the total count.',
      create: 'Low-level: create a record.',
      createMany: 'Low-level: create many records.',
      update: 'Low-level: update a record.',
      updateMany: 'Low-level: update many records.',
      delete: 'Low-level: delete a record.',
      deleteMany: 'Low-level: delete many records.',
      count: 'Low-level: count records.',
    },
  },
};

export function lookupApiMethod(api: StrapiApiId, method: string): string | undefined {
  return STRAPI_APIS[api].methods[method];
}
