import type { AttributeInfo, ComponentDef } from '../model/types';
import { buildComponentUid } from '../model/uid';
import { asRecord, asString, asStringArray, safeParse } from '../util/json';

function parseAttributes(
  attrsObj: Record<string, unknown>,
  raw: string,
  attrsStart: number,
): Record<string, AttributeInfo> {
  const attributes: Record<string, AttributeInfo> = {};
  for (const [name, rawDef] of Object.entries(attrsObj)) {
    // Skip prototype-poisoning keys (`__proto__`/`constructor`/`prototype`) — `attributes[name] =`
    // would otherwise hit the prototype setter and corrupt the object.
    if (name === '__proto__' || name === 'constructor' || name === 'prototype') continue;
    const def = asRecord(rawDef) ?? {};
    const info: AttributeInfo = {
      name,
      type: asString(def.type) ?? 'unknown',
      keyOffset: Math.max(0, raw.indexOf(`"${name}"`, Math.max(0, attrsStart))),
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

export function parseComponentFile(
  raw: string,
  jsonPath: string,
  category: string,
  name: string,
): ComponentDef | undefined {
  const json = asRecord(safeParse(raw));
  if (!json) return undefined;
  const info = asRecord(json.info) ?? {};
  const attrsObj = asRecord(json.attributes) ?? {};
  return {
    uid: buildComponentUid(category, name),
    category,
    name,
    jsonPath,
    info: { displayName: asString(info.displayName) },
    attributes: parseAttributes(attrsObj, raw, raw.indexOf('"attributes"')),
    defOffset: Math.max(0, raw.indexOf('"info"')),
  };
}
