import * as yaml from "js-yaml";
import { convertStr } from "swagger2openapi";

const TARGET_OPENAPI_VERSION = "3.0.3";
const SWAGGER_2_DECLARATION = /^[ \t]{0,3}swagger\s*:\s*(?:"2\.0"|'2\.0'|2(?:\.0)?)\s*(?:#.*)?\r?$/m;

export interface OpenApiConversion {
  converted: boolean;
  from?: "2.0";
  to?: typeof TARGET_OPENAPI_VERSION;
}

export interface PreparedOpenApiDocument {
  content: string;
  conversion: OpenApiConversion;
}

async function convertSwagger2(content: string): Promise<PreparedOpenApiDocument> {
  try {
    const result = await convertStr(content, {
      anchors: true,
      patch: true,
      targetVersion: TARGET_OPENAPI_VERSION,
      warnOnly: false,
    });

    return {
      content: yaml.dump(result.openapi, {
        lineWidth: -1,
        noRefs: true,
      }),
      conversion: {
        converted: true,
        from: "2.0",
        to: TARGET_OPENAPI_VERSION,
      },
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Swagger 2.0 to OpenAPI 3 conversion failed: ${message}`);
  }
}

/**
 * Convert a Swagger 2.0 document to OpenAPI 3.0 before validation.
 * Existing OpenAPI 3 documents and content that cannot yet be parsed are left
 * untouched so the regular linter can report its normal parser/version errors.
 */
export async function prepareOpenApiDocument(
  content: string
): Promise<PreparedOpenApiDocument> {
  let document: unknown;

  try {
    document = yaml.load(content, { json: true });
  } catch {
    // js-yaml 5 is stricter than the converter's legacy YAML parser. Let the
    // converter handle recognizable Swagger 2 documents such as older specs
    // containing trailing commas in flow-style examples.
    if (SWAGGER_2_DECLARATION.test(content)) {
      return convertSwagger2(content);
    }
    return { content, conversion: { converted: false } };
  }

  if (!document || typeof document !== "object" || Array.isArray(document)) {
    return { content, conversion: { converted: false } };
  }

  const spec = document as Record<string, unknown>;
  if (typeof spec.openapi === "string" && spec.openapi.startsWith("3.")) {
    return { content, conversion: { converted: false } };
  }

  const swaggerVersion = spec.swagger;
  const isSwagger2 = swaggerVersion === "2.0" || swaggerVersion === 2;
  if (!isSwagger2) {
    return { content, conversion: { converted: false } };
  }

  return convertSwagger2(content);
}
