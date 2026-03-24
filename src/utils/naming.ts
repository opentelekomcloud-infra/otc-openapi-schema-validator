import { getAllowedAbbreviations, looksLikeAbbreviation, looksLikeUnknownWord } from "@/utils/englishWords";

export type SnakeCaseConfig = {
  methods?: string[];
  checkRequestParameters?: boolean;
  checkRequestBodyFields?: boolean;
  checkResponseBodyFields?: boolean;
  validateTokensAgainstDictionary?: boolean;
  validateAllowedAbbreviations?: boolean;
  ignorePathVersionTokens?: boolean;
  allowDigitsInsideTokens?: boolean;
};

/**
 * Checks whether a field name follows snake_case naming convention.
 *
 * Supports optional digits inside tokens depending on configuration.
 *
 * Examples:
 * - `user_id` -> valid
 * - `user1_id2` -> valid if digits allowed
 * - `UserId` -> invalid
 *
 * @param name Field name to validate.
 * @param allowDigitsInsideTokens Whether digits are allowed inside tokens.
 * @returns true if the name matches snake_case rules.
 */
export function isSnakeCaseName(name: string, allowDigitsInsideTokens: boolean): boolean {
  const pattern = allowDigitsInsideTokens
    ? /^[a-z][a-z0-9]*(?:_[a-z][a-z0-9]*)*$/
    : /^[a-z]+(?:_[a-z]+)*$/;
  return pattern.test(name);
}

/**
 * Splits a snake_case name into individual lowercase tokens.
 *
 * Examples:
 * - `user_id` -> ["user", "id"]
 * - `route_table_id` -> ["route", "table", "id"]
 *
 * @param name Field name in snake_case.
 * @returns Array of normalized lowercase tokens.
 */
export function splitSnakeCaseTokens(name: string): string[] {
  return String(name)
    .split("_")
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Validates a field name against snake_case rules and semantic token checks.
 *
 * This function performs:
 * - snake_case validation
 * - abbreviation validation using allowed abbreviations set
 * - English dictionary validation for tokens
 * - contextual validation using path tokens
 *
 * It combines tokens from the field name and path context to improve validation accuracy.
 *
 * @param name Field name to validate.
 * @param cfg Configuration controlling validation behavior.
 * @param pathTokens Tokens derived from the API path for contextual validation.
 * @returns Array of validation error messages (empty if valid).
 */
export function validateFieldNameTokens(
  name: string,
  cfg: SnakeCaseConfig,
  pathTokens: string[]
): string[] {
  const problems: string[] = [];
  const allowedAbbreviations = getAllowedAbbreviations();

  if (!isSnakeCaseName(name, cfg.allowDigitsInsideTokens !== false)) {
    problems.push(`Field '${name}' must use snake_case with lowercase letters.`);
    return problems;
  }

  const tokens = splitSnakeCaseTokens(name);
  const allContextTokens = new Set<string>([
    ...tokens,
    ...pathTokens.map((t) => t.toLowerCase()),
  ]);

  for (const token of allContextTokens) {
    if (!token) continue;

    if (cfg.validateAllowedAbbreviations && looksLikeAbbreviation(token, allowedAbbreviations)) {
      problems.push(`Token '${token}' in '${name}' looks like a non-approved abbreviation.`);
    }

    if (cfg.validateTokensAgainstDictionary && looksLikeUnknownWord(token)) {
      problems.push(`Token '${token}' in '${name}' is not a recognized English word or approved abbreviation.`);
    }
  }

  return problems;
}
