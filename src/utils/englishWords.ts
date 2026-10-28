import englishWords from "an-array-of-english-words";
import { validateAllowedAbbreviations } from "@/lib/abbreviations";

let ALLOWED_ABBREVIATIONS = new Set<string>();
let abbreviationsLoading: Promise<void> | undefined;

export function getAllowedAbbreviations(): Set<string> {
  return new Set(ALLOWED_ABBREVIATIONS);
}

export function setAllowedAbbreviations(value: unknown): void {
  ALLOWED_ABBREVIATIONS = new Set(validateAllowedAbbreviations(value));
}

export function loadAllowedAbbreviationsFromApi(): Promise<void> {
  if (!abbreviationsLoading) {
    abbreviationsLoading = (async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(new Error("Timed out loading allowed abbreviations.")), 10_000);
      try {
        const res = await fetch("/api/abbreviations", { signal: controller.signal });
        if (!res.ok) throw new Error(`Failed to fetch abbreviations: HTTP ${res.status}.`);
        setAllowedAbbreviations(await res.json());
      } finally {
        clearTimeout(timeout);
      }
    })().catch((error: unknown) => {
      abbreviationsLoading = undefined;
      throw error;
    });
  }
  return abbreviationsLoading;
}

// Load full English dictionary from an-array-of-english-words
const ENGLISH_DICTIONARY = new Set<string>(
  (englishWords as string[]).map((w) => w.toLowerCase())
);

export function splitPathIntoTokens(path: string): string[] {
  // Remove leading/trailing slashes and split by '/'
  const segments = path.split("/").filter(Boolean);

  const tokens: string[] = [];

  for (const seg of segments) {
    // Ignore path parameters like {project_id}
    if (/^\{.*\}$/.test(seg)) continue;
    // Ignore version segment like v1, v2.0, etc.
    if (/^v[0-9]+(\.[0-9]+)?$/.test(seg)) continue;

    // Split by hyphen and underscore
    const subSegs = seg.split(/[-_]/g);
    for (const sub of subSegs) {
      if (!sub) continue;
      // Split camelCase into lowercase tokens
      const camelParts = sub
        .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
        .split(/\s+/)
        .filter(Boolean)
        .map((p) => p.toLowerCase());
      tokens.push(...camelParts);
    }
  }

  return tokens;
}

export function looksLikeAbbreviation(token: string, allowed: ReadonlySet<string>): boolean {
  if (!token) return false;
  if (!/^[a-z]+$/.test(token)) return false; // only letters
  if (allowed.has(token) || (token.endsWith("s") && allowed.has(token.slice(0, -1)))) return false;
  if (token.length > 5) return false; // long words are unlikely to be abbreviations
  if (token.length <= 1) return false;

  // Heuristic: treat as abbreviation only if it has no vowels at all (pure acronym-like)
  const vowels = token.match(/[aeiou]/g)?.length ?? 0;
  return vowels === 0;
}

export function looksLikeUnknownWord(token: string, allowed: ReadonlySet<string> = ALLOWED_ABBREVIATIONS): boolean {
  if (!token) return false;
  if (!/^[a-z]+$/.test(token)) return false;

  // Accept all valid English words and our domain-known words
  if (ENGLISH_DICTIONARY.has(token) || allowed.has(token)) return false;

  // Ignore very short tokens (like id, x, y)
  if (token.length <= 2) return false;

  const vowels = token.match(/[aeiou]/g)?.length ?? 0;

  // Pure acronyms without vowels are suspicious
  if (vowels === 0) return true;

  // Long tokens that are not in the dictionary are suspicious
  if (token.length >= 6) return true;

  // Short tokens (<=4) with at least one vowel (e.g. flow, logs, tags) are considered okay
  if (token.length <= 4 && vowels >= 1) return false;

  // For medium-length tokens, flag only those with very few vowels (likely constructed abbreviations)
  if (vowels <= 1) return true;

  // Otherwise treat as acceptable
  return false;
}
