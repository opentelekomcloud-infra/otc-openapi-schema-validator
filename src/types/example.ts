import type { NativeParameterSchema } from "./openapi";

export type ExampleRequirement = "required" | "forbidden" | "optional";

export type MethodValidationConfig = {
  requestExample?: ExampleRequirement;
  responseExample?: ExampleRequirement;
  requestValidation?: {
    includeRequestBodySchema?: boolean;
    includeOperationParameters?: {
      query?: boolean;
      path?: boolean;
      header?: boolean;
      cookie?: boolean;
    };
  };
};

export type RuleConfig = {
  jsonStringMode?: "value" | "serializedWhenStructured";
  formatValidation?: Record<string, "json">;
  methods?: Record<string, MethodValidationConfig>;
  exampleSources?: {
    request?: string[];
    response?: string[];
  };
  responseSelection?: {
    mode?: string;
    include?: string[];
  };
  requestValidation?: {
    includeRequestBodySchema?: boolean;
    includeOperationParameters?: {
      query?: boolean;
      path?: boolean;
      header?: boolean;
      cookie?: boolean;
    };
    requireRequiredBodyFields?: boolean;
    forbidUndefinedFields?: boolean;
  };
  responseValidation?: {
    validateAgainstResponseSchema?: boolean;
    forbidUndefinedFields?: boolean;
  };
};

export type FoundExample = {
  source: string;
  value: unknown;
};

export interface NativeExample extends FoundExample {
  readonly scope: "payload" | "property";
  readonly direction: "request" | "response";
  readonly pointer: string;
  readonly declarationPointer: string;
  readonly resolvedPointer: string;
  readonly mediaType: string | undefined;
  readonly statusCode: string | undefined;
  readonly schema: NativeParameterSchema | undefined;
}
