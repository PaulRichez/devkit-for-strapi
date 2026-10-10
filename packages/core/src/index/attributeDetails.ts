import type { AttributeInfo } from '../model/types';
import { asString, asStringArray } from '../util/json';

/** The descriptive fields of an attribute definition (relation kind, flags, enum) — for display. */
export function attributeDetails(def: Record<string, unknown>): Partial<AttributeInfo> {
  const out: Partial<AttributeInfo> = {};
  const relation = asString(def.relation);
  if (relation) out.relation = relation;
  const mappedBy = asString(def.mappedBy);
  if (mappedBy) out.mappedBy = mappedBy;
  const inversedBy = asString(def.inversedBy);
  if (inversedBy) out.inversedBy = inversedBy;
  if (def.repeatable === true) out.repeatable = true;
  if (def.required === true) out.required = true;
  if (def.unique === true) out.unique = true;
  if (def.private === true) out.private = true;
  const values = asStringArray(def.enum);
  if (values) out.enum = values;
  return out;
}
