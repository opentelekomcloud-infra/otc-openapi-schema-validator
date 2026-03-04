import { resolveRefDeep, schemaIsArrayOfObjects } from "@/utils/schema";

/**
 * Detects the common "tags/action" batch pattern: object payload with
 * `action` enum containing create/delete and `tags` as `array<object>`.
 */
export function isActionTagsBatchPayload(schema: any, spec: any, refCache: Map<string, any>): boolean {
  const s = resolveRefDeep(schema, refCache, spec);
  if (!s || typeof s !== "object") return false;

  const props = (s as any).properties;
  if (!props || typeof props !== "object") return false;

  const action = (props as any).action;
  const tags = (props as any).tags;

  const actionResolved = action ? resolveRefDeep(action, refCache, spec) : null;
  const tagsResolved = tags ? resolveRefDeep(tags, refCache, spec) : null;

  const actionEnum =
    actionResolved?.enum ??
    actionResolved?.schema?.enum;

  const actionEnumLower = Array.isArray(actionEnum)
    ? actionEnum.map((v: any) => String(v).toLowerCase())
    : [];

  const hasCreateOrDelete = actionEnumLower.includes("create") || actionEnumLower.includes("delete");
  if (!hasCreateOrDelete) return false;

  // tags must be array<object>
  if (!tagsResolved) return false;
  return schemaIsArrayOfObjects(tagsResolved, spec, refCache);
}
