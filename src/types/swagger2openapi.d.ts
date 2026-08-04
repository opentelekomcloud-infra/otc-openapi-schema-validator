declare module "swagger2openapi" {
  interface ConvertOptions {
    anchors?: boolean;
    patch?: boolean;
    targetVersion?: string;
    warnOnly?: boolean;
    [key: string]: unknown;
  }

  interface ConvertResult {
    openapi: Record<string, unknown>;
    [key: string]: unknown;
  }

  export function convertObj(
    swagger: Record<string, unknown>,
    options: ConvertOptions
  ): Promise<ConvertResult>;

  export function convertStr(
    swagger: string,
    options: ConvertOptions
  ): Promise<ConvertResult>;
}
