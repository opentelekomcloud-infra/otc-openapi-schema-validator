import { checkExamplesFormat } from "@/functions/checkExamplesFormat";

describe("checkExamplesFormat (DOC-040-01-2507-2507-M)", () => {
  const baseRule: any = {
    id: "DOC-040-01-2507-2507-M",
    title: "API Reference Document Sample Requirements",
    message: "Operation examples must be present or absent according to method-specific requirements, and must match the defined API contract.",
    severity: "critical",
    call: {
      function: "checkExamplesFormat",
      functionParams: {
        methods: {
          get: {
            requestExample: "forbidden",
            responseExample: "required",
            requestValidation: {
              includeRequestBodySchema: false,
              includeOperationParameters: {
                query: true,
                path: true,
                header: false,
                cookie: false,
              },
            },
          },
          post: {
            requestExample: "required",
            responseExample: "required",
            requestValidation: {
              includeRequestBodySchema: true,
              includeOperationParameters: {
                query: false,
                path: false,
                header: false,
                cookie: false,
              },
            },
          },
          put: {
            requestExample: "required",
            responseExample: "required",
            requestValidation: {
              includeRequestBodySchema: true,
              includeOperationParameters: {
                query: false,
                path: false,
                header: false,
                cookie: false,
              },
            },
          },
          patch: {
            requestExample: "required",
            responseExample: "required",
            requestValidation: {
              includeRequestBodySchema: true,
              includeOperationParameters: {
                query: false,
                path: false,
                header: false,
                cookie: false,
              },
            },
          },
          delete: {
            requestExample: "forbidden",
            responseExample: "forbidden",
            requestValidation: {
              includeRequestBodySchema: false,
              includeOperationParameters: {
                query: false,
                path: false,
                header: false,
                cookie: false,
              },
            },
          },
        },
        exampleSources: {
          request: ["content.example", "content.examples"],
          response: ["content.example", "content.examples"],
        },
        responseSelection: {
          mode: "successOnly",
          include: ["200", "201", "202", "204"],
        },
        requestValidation: {
          includeRequestBodySchema: true,
          includeOperationParameters: {
            query: false,
            path: false,
            header: false,
            cookie: false,
          },
          requireRequiredBodyFields: true,
          forbidUndefinedFields: true,
        },
        responseValidation: {
          validateAgainstResponseSchema: true,
          forbidUndefinedFields: true,
        },
      },
    },
  };
  test("GET requires response example and forbids request example", () => {
    const spec: any = {
      openapi: "3.0.0",
      paths: {
        "/v1/resources/{id}": {
          get: {
            parameters: [
              { name: "id", in: "path", required: true, schema: { type: "string" } },
              { name: "filter", in: "query", required: false, schema: { type: "string" } },
            ],
            responses: {
              "200": {
                description: "OK",
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      properties: {
                        id: { type: "string" },
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
  /v1/resources/{id}:
    get:
      parameters: []
      responses:
        "200":
          description: OK
`;
    const diags = checkExamplesFormat(spec, content, baseRule);
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("Missing required response example");
    expect(content.slice(diags[0].from, diags[0].to)).toBe("get");
  });

  test("GET flags request example as forbidden", () => {
    const spec: any = {
      openapi: "3.0.0",
      paths: {
        "/v1/resources/{id}": {
          get: {
            requestBody: {
              content: {
                "application/json": {
                  example: { id: "1", filter: "abc" },
                },
              },
            },
            responses: {
              "200": {
                description: "OK",
                content: {
                  "application/json": {
                    example: { id: "1" },
                    schema: {
                      type: "object",
                      properties: {
                        id: { type: "string" },
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
  /v1/resources/{id}:
    get:
      requestBody: {}
      responses:
        "200":
          description: OK
`;
    const diags = checkExamplesFormat(spec, content, baseRule);
    expect(diags.length).toBeGreaterThanOrEqual(1);
    expect(diags.some((d) => d.message.includes("Request example is not allowed for GET operations"))).toBe(true);
  });

  test("POST requires both request and response examples", () => {
    const spec: any = {
      openapi: "3.0.0",
      paths: {
        "/v1/resources": {
          post: {
            requestBody: {
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    required: ["name"],
                    properties: {
                      name: { type: "string" },
                    },
                  },
                },
              },
            },
            responses: {
              "201": {
                description: "Created",
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      properties: {
                        id: { type: "string" },
                        name: { type: "string" },
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
  /v1/resources:
    post:
      requestBody: {}
      responses:
        "201":
          description: Created
`;
    const diags = checkExamplesFormat(spec, content, baseRule);
    expect(diags).toHaveLength(2);
    expect(diags.some((d) => d.message.includes("Missing required request example"))).toBe(true);
    expect(diags.some((d) => d.message.includes("Missing required response example"))).toBe(true);
  });

  test("POST request example must contain required body fields", () => {
    const spec: any = {
      openapi: "3.0.0",
      paths: {
        "/v1/resources": {
          post: {
            requestBody: {
              content: {
                "application/json": {
                  example: { description: "only optional" },
                  schema: {
                    type: "object",
                    required: ["name"],
                    properties: {
                      name: { type: "string" },
                      description: { type: "string" },
                    },
                  },
                },
              },
            },
            responses: {
              "201": {
                description: "Created",
                content: {
                  "application/json": {
                    example: { id: "1", name: "demo" },
                    schema: {
                      type: "object",
                      properties: {
                        id: { type: "string" },
                        name: { type: "string" },
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
  /v1/resources:
    post:
      requestBody:
        content:
          application/json:
            example: {}
      responses:
        "201":
          description: Created
`;
    const diags = checkExamplesFormat(spec, content, baseRule);
    expect(diags.some((d) => d.message.includes("missing required body field 'name'"))).toBe(true);
  });

  test("POST request example must not contain undefined body fields", () => {
    const spec: any = {
      openapi: "3.0.0",
      paths: {
        "/v1/resources": {
          post: {
            requestBody: {
              content: {
                "application/json": {
                  example: { name: "demo", extra_field: true },
                  schema: {
                    type: "object",
                    required: ["name"],
                    properties: {
                      name: { type: "string" },
                    },
                  },
                },
              },
            },
            responses: {
              "201": {
                description: "Created",
                content: {
                  "application/json": {
                    example: { id: "1", name: "demo" },
                    schema: {
                      type: "object",
                      properties: {
                        id: { type: "string" },
                        name: { type: "string" },
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
  /v1/resources:
    post:
      requestBody:
        content:
          application/json:
            example: {}
      responses:
        "201":
          description: Created
`;
    const diags = checkExamplesFormat(spec, content, baseRule);
    expect(diags.some((d) => d.message.includes("contains field 'extra_field' that is not defined in the request schema"))).toBe(true);
  });

  test("response example must not contain undefined response fields", () => {
    const spec: any = {
      openapi: "3.0.0",
      paths: {
        "/v1/resources/{id}": {
          get: {
            parameters: [
              { name: "id", in: "path", required: true, schema: { type: "string" } },
            ],
            responses: {
              "200": {
                description: "OK",
                content: {
                  "application/json": {
                    example: { id: "1", unknown: "bad" },
                    schema: {
                      type: "object",
                      properties: {
                        id: { type: "string" },
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
  /v1/resources/{id}:
    get:
      responses:
        "200":
          description: OK
          content:
            application/json:
              example: {}
`;

    const diags = checkExamplesFormat(spec, content, baseRule);
    expect(diags.some((d) => d.message.includes("Response example for status '200' contains field 'unknown'"))).toBe(true);
  });

  test("valid POST examples pass without diagnostics", () => {
    const spec: any = {
      openapi: "3.0.0",
      paths: {
        "/v1/resources": {
          post: {
            requestBody: {
              content: {
                "application/json": {
                  example: { name: "demo", description: "ok" },
                  schema: {
                    type: "object",
                    required: ["name"],
                    properties: {
                      name: { type: "string" },
                      description: { type: "string" },
                    },
                  },
                },
              },
            },
            responses: {
              "201": {
                description: "Created",
                content: {
                  "application/json": {
                    example: { id: "1", name: "demo", description: "ok" },
                    schema: {
                      type: "object",
                      properties: {
                        id: { type: "string" },
                        name: { type: "string" },
                        description: { type: "string" },
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
  /v1/resources:
    post:
      requestBody:
        content:
          application/json:
            example: {}
      responses:
        "201":
          description: Created
          content:
            application/json:
              example: {}
`;

    const diags = checkExamplesFormat(spec, content, baseRule);
    expect(diags).toHaveLength(0);
  });

  test("DELETE forbids response examples", () => {
    const spec: any = {
      openapi: "3.0.0",
      paths: {
        "/v1/resources/{id}": {
          delete: {
            responses: {
              "204": {
                description: "No Content",
                content: {
                  "application/json": {
                    example: { deleted: true },
                    schema: {
                      type: "object",
                      properties: {
                        deleted: { type: "boolean" },
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
  /v1/resources/{id}:
    delete:
      responses:
        "204":
          description: No Content
`;

    const diags = checkExamplesFormat(spec, content, baseRule);
    expect(diags.some((d) => d.message.includes("Response example is not allowed for DELETE operations"))).toBe(true);
  });
});
