/**
 * Checks whether a string contains at least one of the provided substrings.
 * Comparison is case-insensitive.
 *
 * @param haystack The source string to search in.
 * @param needles List of substrings to look for.
 * @returns true if any substring from `needles` is found inside `haystack`.
 */
export function textContainsAny(haystack: string, needles: string[]): boolean {
  const h = haystack.toLowerCase();
  return needles.some((n) => h.includes(String(n).toLowerCase()));
}

/**
 * Detects presence of a query flag in a URL path.
 *
 * The function looks for occurrences like:
 *  - `?flag`
 *  - `?flag=`
 *  - `&flag`
 *  - `&flag=`
 *
 * Comparison is case-insensitive and works on raw OpenAPI path strings.
 *
 * @param path URL path possibly containing query parameters.
 * @param flag Query flag name to detect.
 * @returns true if the flag is present in the path.
 */
export function pathHasQueryFlag(path: string, flag: string): boolean {
  const f = String(flag).toLowerCase();
  const p = path.toLowerCase();
  // match `?flag` or `&flag` or `?flag=`
  return p.includes(`?${f}`) || p.includes(`&${f}`);
}

/**
 * Checks whether an example field path matches any allowed schema path.
 *
 * This helper allows both full-path matches and relaxed "leaf" matches.
 * Leaf matching is useful when example structures are flatter than the
 * schema traversal paths.
 *
 * Examples:
 *  schema path: `items[].name`
 *  example path: `name`  → valid
 *
 * @param examplePath Path extracted from an example payload.
 * @param allowedPaths Set of valid schema paths collected from the schema.
 * @returns true if the example path matches a schema path.
 */
export function matchesAnySchemaPath(examplePath: string, allowedPaths: Set<string>): boolean {
  if (allowedPaths.has(examplePath)) return true;

  // Allow leaf-name match when schema traversal is deeper than the example shape.
  const leaf = examplePath.split(".").pop() ?? examplePath;
  for (const p of allowedPaths) {
    if (p === leaf || p.endsWith(`.${leaf}`) || p.endsWith(`[].${leaf}`)) return true;
  }

  return false;
}

/**
 * Checks whether a required schema path is present in an example payload.
 *
 * Supports both full-path and leaf-name matching to tolerate differences
 * between example nesting and schema traversal depth.
 *
 * Example:
 *  required schema path: `items[].id`
 *  example path: `id` → considered valid
 *
 * @param requiredPath Required path derived from the schema.
 * @param examplePaths Set of paths extracted from the example payload.
 * @returns true if the required field is present in the example.
 */
export function matchesRequiredPath(requiredPath: string, examplePaths: Set<string>): boolean {
  if (examplePaths.has(requiredPath)) return true;
  const leaf = requiredPath.split(".").pop() ?? requiredPath;
  for (const p of examplePaths) {
    if (p === leaf || p.endsWith(`.${leaf}`) || p.endsWith(`[].${leaf}`)) return true;
  }
  return false;
}
