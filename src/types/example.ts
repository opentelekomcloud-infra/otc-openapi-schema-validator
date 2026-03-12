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
  value: any;
};
