import type { AttributeInfo, ContentType, ContentTypeSource } from '../model/types';
import { buildContentTypeUid, buildPluginContentTypeUid } from '../model/uid';
import { asRecord, asString, asStringArray, safeParse } from '../util/json';

/** Find the offset of `"key"` in raw JSON, searching after `from`. */
function findKeyOffset(raw: string, key: string, from: number): number {
  const idx = raw.indexOf(`"${key}"`, Math.max(0, from));
  return idx >= 0 ? idx : 0;
}

function parseAttributes(
  attrsObj: Record<string, unknown>,
  raw: string,
  attrsStart: number,
): Record<string, AttributeInfo> {
  const attributes: Record<string, AttributeInfo> = {};
  for (const [name, rawDef] of Object.entries(attrsObj)) {
    // A schema.json key like `__proto__` would, via `attributes[name] = …`, hit the
    // prototype setter and corrupt the object — skip the dangerous keys (never real attrs).
    if (name === '__proto__' || name === 'constructor' || name === 'prototype') continue;
    const def = asRecord(rawDef) ?? {};
    const info: AttributeInfo = {
      name,
      type: asString(def.type) ?? 'unknown',
      keyOffset: findKeyOffset(raw, name, attrsStart),
    };
    const target = asString(def.target);
    if (target) info.target = target;
    const component = asString(def.component);
    if (component) info.component = component;
    const components = asStringArray(def.components);
    if (components) info.components = components;
    attributes[name] = info;
  }
  return attributes;
}

export interface SchemaContext {
  schemaPath: string;
  ctName: string;
  source: ContentTypeSource;
  apiName: string;
  pluginName?: string;
}

export function parseSchemaFile(raw: string, ctx: SchemaContext): ContentType | undefined {
  const json = asRecord(safeParse(raw));
  if (!json) return undefined;

  const uid =
    ctx.source === 'plugin'
      ? buildPluginContentTypeUid(ctx.pluginName ?? ctx.apiName, ctx.ctName)
      : buildContentTypeUid(ctx.apiName, ctx.ctName);

  const attrsObj = asRecord(json.attributes) ?? {};
  const attrsStart = raw.indexOf('"attributes"');
  const info = asRecord(json.info) ?? {};

  const result: ContentType = {
    uid,
    kind: json.kind === 'singleType' ? 'singleType' : 'collectionType',
    apiName: ctx.apiName,
    ctName: ctx.ctName,
    schemaPath: ctx.schemaPath,
    source: ctx.source,
    info: {
      singularName: asString(info.singularName),
      pluralName: asString(info.pluralName),
      displayName: asString(info.displayName),
    },
    attributes: parseAttributes(attrsObj, raw, attrsStart),
    defOffset: Math.max(0, raw.indexOf('"kind"')),
  };
  if (ctx.pluginName) result.pluginName = ctx.pluginName;
  return result;
}
