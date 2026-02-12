/**
 * Safely compiles a string into a RegExp.
 * Returns null if the pattern is missing or invalid.
 */
export function safeRegex(pattern?: string): RegExp | null {
  if (!pattern) return null;
  try {
    return new RegExp(pattern);
  } catch {
    return null;
  }
}
