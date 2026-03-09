import { AsyncResponseConfig } from "@/types/async";

/**
 * Returns the response object for a specific HTTP status code from an OpenAPI operation.
 *
 * Supports both string and numeric keys because OpenAPI responses
 * may be defined as "202" or 202 depending on the parser.
 *
 * @param operation OpenAPI operation object
 * @param statusCode HTTP status code to retrieve
 * @returns response object or null if not present
 */
export function getResponseObjectByStatus(operation: any, statusCode: string): any | null {
  const responses = operation?.responses;
  if (!responses || typeof responses !== "object") return null;
  return (responses as any)[statusCode] ?? (responses as any)[Number(statusCode)] ?? null;
}

/**
 * Checks whether an OpenAPI operation defines a response for
 * the provided HTTP status code.
 *
 * @param operation OpenAPI operation object
 * @param statusCode HTTP status code to check
 * @returns true if the response exists
 */
export function operationHasStatusCode(operation: any, statusCode: string): boolean {
  return Boolean(getResponseObjectByStatus(operation, statusCode));
}

/**
 * Determines whether an operation should be treated as asynchronous.
 *
 * The rule considers an operation asynchronous if it defines the
 * configured async success status code (default: 202).
 *
 * @param operation OpenAPI operation object
 * @param cfg Async rule configuration
 * @returns true if operation matches async response pattern
 */
export function isAsyncOperation(operation: any, cfg: AsyncResponseConfig): boolean {
  const asyncStatus = String(cfg.asyncMatch?.successStatusCode ?? "202");
  return operationHasStatusCode(operation, asyncStatus);
}
