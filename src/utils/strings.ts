export function findInvalidPercentEscape(path: string): { index: number; length: number } | null {
  // Matches '%' not followed by exactly two hex digits
  const re = /%(?![0-9A-Fa-f]{2})/;
  const m = path.match(re);
  if (!m || m.index === undefined) return null;
  return { index: m.index, length: m[0].length || 1 };
}
