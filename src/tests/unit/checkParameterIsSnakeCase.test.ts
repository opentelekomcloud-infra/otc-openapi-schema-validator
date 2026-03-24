
import { checkParameterIsSnakeCase } from "@/functions/checkParameterIsSnakeCase";

jest.mock("@/utils/englishWords", () => ({
  splitPathIntoTokens: jest.fn((path: string) =>
    String(path)
      .split("/")
      .filter(Boolean)
      .flatMap((seg) => seg.split(/[-_]/g))
      .map((t) => t.replace(/[{}]/g, "").toLowerCase())
      .filter(Boolean)
  ),
  looksLikeAbbreviation: jest.fn((token: string, allowed: Set<string>) => {
    const t = String(token).toLowerCase();
    return t === "cfg" && !allowed.has("cfg");
  }),
  looksLikeUnknownWord: jest.fn((token: string) => String(token).toLowerCase() === "mysteryword"),
  getAllowedAbbreviations: jest.fn(() => new Set(["id", "url", "uri", "ip"])),
}));

describe("checkParameterIsSnakeCase (ARG-010-01-2507-2509-M)", () => {
  const rule: any = {
    id: "ARG-010-01-2507-2509-M",
    title: "Request and Response Parameter Naming Convention",
    message:
      "Request and response parameters must use snake_case with lowercase letters, and tokens should be valid English words or approved abbreviations.",
    severity: "critical",
    call: {
      function: "checkParameterIsSnakeCase",
      functionParams: {
        methods: ["get", "post", "put", "patch", "delete"],
        checkRequestParameters: true,
        checkRequestBodyFields: true,
        checkResponseBodyFields: true,
        validateTokensAgainstDictionary: true,
        validateAllowedAbbreviations: true,
        allowDigitsInsideTokens: true,
      },
    },
  };

  test("passes for valid snake_case parameter and body field names", () => {
    const spec: any = {
      openapi: "3.0.0",
      paths: {
        "/v1/users/{user_id}": {
          post: {
            parameters: [
              { name: "user_id", in: "path", required: true, schema: { type: "string" } },
              { name: "page_size", in: "query", required: false, schema: { type: "integer" } },
            ],
            requestBody: {
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      user_name: { type: "string" },
                      profile_url: { type: "string" },
                    },
                  },
                },
              },
            },
            responses: {
              "200": {
                description: "OK",
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      properties: {
                        request_id: { type: "string" },
                        user_name: { type: "string" },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    };

    const content = `
openapi: 3.0.0
paths:
  /v1/users/{user_id}:
    post:
      parameters: []
`;

    const diags = checkParameterIsSnakeCase(spec, content, rule);
    expect(diags).toHaveLength(0);
  });

  test("flags non-snake_case request parameter names", () => {
    const spec: any = {
      openapi: "3.0.0",
      paths: {
        "/v1/users": {
          get: {
            parameters: [
              { name: "userId", in: "query", required: false, schema: { type: "string" } },
            ],
            responses: {},
          },
        },
      },
    };

    const content = `
openapi: 3.0.0
paths:
  /v1/users:
    get:
      parameters: []
`;

    const diags = checkParameterIsSnakeCase(spec, content, rule);
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("Parameter 'userId'");
    expect(diags[0].message).toContain("must use snake_case");
    expect(content.slice(diags[0].from, diags[0].to)).toBe("get");
  });

  test("ignores header parameters", () => {
    const spec: any = {
      openapi: "3.0.0",
      paths: {
        "/v1/users": {
          get: {
            parameters: [
              { name: "X-Auth-Token", in: "header", required: true, schema: { type: "string" } },
            ],
            responses: {},
          },
        },
      },
    };

    const content = `
openapi: 3.0.0
paths:
  /v1/users:
    get:
      parameters: []
`;

    const diags = checkParameterIsSnakeCase(spec, content, rule);
    expect(diags).toHaveLength(0);
  });

  test("flags invalid request body field names", () => {
    const spec: any = {
      openapi: "3.0.0",
      paths: {
        "/v1/users": {
          post: {
            requestBody: {
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      userName: { type: "string" },
                    },
                  },
                },
              },
            },
            responses: {},
          },
        },
      },
    };

    const content = `
openapi: 3.0.0
paths:
  /v1/users:
    post:
      requestBody: {}
`;

    const diags = checkParameterIsSnakeCase(spec, content, rule);
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("Request body field 'userName'");
    expect(diags[0].message).toContain("must use snake_case");
  });

  test("flags invalid response body field names", () => {
    const spec: any = {
      openapi: "3.0.0",
      paths: {
        "/v1/users": {
          get: {
            responses: {
              "200": {
                description: "OK",
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      properties: {
                        displayName: { type: "string" },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    };

    const content = `
openapi: 3.0.0
paths:
  /v1/users:
    get:
      responses: {}
`;

    const diags = checkParameterIsSnakeCase(spec, content, rule);
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("Response field 'displayName' in status '200'");
    expect(diags[0].message).toContain("must use snake_case");
  });

  test("flags non-approved abbreviations", () => {
    const spec: any = {
      openapi: "3.0.0",
      paths: {
        "/v1/users": {
          get: {
            parameters: [
              { name: "cfg_id", in: "query", required: false, schema: { type: "string" } },
            ],
            responses: {},
          },
        },
      },
    };

    const content = `
openapi: 3.0.0
paths:
  /v1/users:
    get:
      parameters: []
`;

    const diags = checkParameterIsSnakeCase(spec, content, rule);
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("Token 'cfg' in 'cfg_id' looks like a non-approved abbreviation");
  });

  test("flags unknown words", () => {
    const spec: any = {
      openapi: "3.0.0",
      paths: {
        "/v1/users": {
          post: {
            requestBody: {
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      mysteryword_id: { type: "string" },
                    },
                  },
                },
              },
            },
            responses: {},
          },
        },
      },
    };

    const content = `
openapi: 3.0.0
paths:
  /v1/users:
    post:
      requestBody: {}
`;

    const diags = checkParameterIsSnakeCase(spec, content, rule);
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("Token 'mysteryword' in 'mysteryword_id' is not a recognized English word or approved abbreviation");
  });

  test("resolves $ref parameters and schemas", () => {
    const spec: any = {
      openapi: "3.0.0",
      paths: {
        "/v1/users": {
          patch: {
            parameters: [
              { $ref: "#/components/parameters/UserIdInQuery" },
            ],
            requestBody: {
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/PatchUserBody" },
                },
              },
            },
            responses: {
              "200": {
                description: "OK",
                content: {
                  "application/json": {
                    schema: { $ref: "#/components/schemas/PatchUserResponse" },
                  },
                },
              },
            },
          },
        },
      },
      components: {
        parameters: {
          UserIdInQuery: {
            name: "user_id",
            in: "query",
            required: false,
            schema: { type: "string" },
          },
        },
        schemas: {
          PatchUserBody: {
            type: "object",
            properties: {
              user_name: { type: "string" },
            },
          },
          PatchUserResponse: {
            type: "object",
            properties: {
              result_code: { type: "string" },
            },
          },
        },
      },
    };

    const content = `
openapi: 3.0.0
paths:
  /v1/users:
    patch:
      parameters: []
`;

    const diags = checkParameterIsSnakeCase(spec, content, rule);
    expect(diags).toHaveLength(0);
  });
});

