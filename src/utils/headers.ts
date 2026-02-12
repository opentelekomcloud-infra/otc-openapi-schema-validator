/**
 * Determines whether a header should be treated as a "custom" header for validation.
 *
 * Current behavior: any header not in the known standard header list is treated as custom.
 */
export function isCustomHeader(
  headerName: string,
  standardHeaders: Set<string>,
): boolean {
  const lower = headerName.toLowerCase();

  // Treat known / explicitly provided standard headers as non-custom.
  if (standardHeaders.has(lower)) return false;

  // Everything else is treated as a custom header candidate and must match the regex.
  return true;
}
