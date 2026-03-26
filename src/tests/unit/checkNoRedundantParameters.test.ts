import { checkNoRedundantParameters } from "@/functions/checkNoRedundantParameters";

describe("checkNoRedundantParameters (ARG-050-01-2507-2507-O)", () => {
  const rule: any = {
    id: "ARG-050-01-2507-2507-O",
    title: "Reserved and Redundant Parameter Design",
    message: "Parameters must not expose undocumented reserved fields or duplicate semantics without explicit documentation.",
    description:
      "Checks that reserved or currently unused parameters are explicitly marked and documented, and that duplicate semantics are not introduced inside the same parameter/body/response container without justification.",
    severity: "high",
    call: {
      function: "checkNoRedundantParameters",
      functionParams: {
        checkReservedMarkerForUnused: true,
        reservedFieldName: "x-reserved",
        reservedDescriptionRequired: true,
        checkDuplicateNamesWithinSameContainer: true,
        semanticDuplicateDetectionMode: "descriptionBased",
        minDescriptionSimilarityThreshold: 0.85,
        compareScopesSeparately: true,
      },
    },
  };

  test("passes when parameters and body/response fields are distinct and documented", () => {
    const spec: any = {
      openapi: "3.0.0",
      paths: {
        "/v1/resources": {
          post: {
            parameters: [
              {
                name: "limit",
                in: "query",
                description: "Maximum number of resources returned.",
                schema: { type: "integer" },
              },
              {
                name: "marker",
                in: "query",
                description: "Pagination marker for the next page.",
                schema: { type: "string" },
              },
            ],
            requestBody: {
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      resource_name: {
                        type: "string",
                        description: "Human-readable resource name.",
                      },
                      resource_type: {
                        type: "string",
                        description: "Type of the resource to create.",
                      },
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
                        request_id: {
                          type: "string",
                          description: "Unique request identifier.",
                        },
                        status: {
                          type: "string",
                          description: "Processing status of the request.",
                        },
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
      parameters: []
`;

    const diags = checkNoRedundantParameters(spec, content, rule);
    expect(diags).toHaveLength(0);
  });

  test("flags reserved-looking parameter when x-reserved marker is missing", () => {
    const spec: any = {
      openapi: "3.0.0",
      paths: {
        "/v1/resources": {
          get: {
            parameters: [
              {
                name: "future_filter",
                in: "query",
                description: "Reserved for future use.",
                schema: { type: "string" },
              },
            ],
          },
        },
      },
    };

    const content = `
openapi: 3.0.0
paths:
  /v1/resources:
    get:
      parameters: []
`;

    const diags = checkNoRedundantParameters(spec, content, rule);
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("missing 'x-reserved: true'");
    expect(diags[0].message).toContain("future_filter");
    expect(content.slice(diags[0].from, diags[0].to)).toBe("get");
  });

  test("passes when reserved-looking parameter has x-reserved marker and description", () => {
    const spec: any = {
      openapi: "3.0.0",
      paths: {
        "/v1/resources": {
          get: {
            parameters: [
              {
                name: "future_filter",
                in: "query",
                description: "Reserved for future use.",
                "x-reserved": true,
                schema: { type: "string" },
              },
            ],
          },
        },
      },
    };

    const content = `
openapi: 3.0.0
paths:
  /v1/resources:
    get:
      parameters: []
`;

    const diags = checkNoRedundantParameters(spec, content, rule);
    expect(diags).toHaveLength(0);
  });

  test("flags duplicate parameter names within the same scope", () => {
    const spec: any = {
      openapi: "3.0.0",
      paths: {
        "/v1/resources": {
          get: {
            parameters: [
              {
                name: "limit",
                in: "query",
                description: "Maximum number of resources returned.",
                schema: { type: "integer" },
              },
              {
                name: "limit",
                in: "query",
                description: "Maximum number of items in the response.",
                schema: { type: "integer" },
              },
            ],
          },
        },
      },
    };

    const content = `
openapi: 3.0.0
paths:
  /v1/resources:
    get:
      parameters: []
`;

    const diags = checkNoRedundantParameters(spec, content, rule);
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("Duplicate field name 'limit'");
    expect(diags[0].message).toContain("parameters (query)");
  });

  test("does not treat same parameter name in different scopes as duplicate when compareScopesSeparately is true", () => {
    const spec: any = {
      openapi: "3.0.0",
      paths: {
        "/v1/{id}/resources": {
          get: {
            parameters: [
              {
                name: "id",
                in: "path",
                description: "Identifier in the URI path.",
                required: true,
                schema: { type: "string" },
              },
              {
                name: "id",
                in: "query",
                description: "Identifier used for filter experiments.",
                required: false,
                schema: { type: "string" },
              },
            ],
          },
        },
      },
    };

    const content = `
openapi: 3.0.0
paths:
  /v1/{id}/resources:
    get:
      parameters: []
`;

    const diags = checkNoRedundantParameters(spec, content, rule);
    expect(diags).toHaveLength(0);
  });

  test("flags semantic duplicates in parameters based on similar descriptions", () => {
    const spec: any = {
      openapi: "3.0.0",
      paths: {
        "/v1/resources": {
          get: {
            parameters: [
              {
                name: "limit",
                in: "query",
                description: "Maximum number of resources returned in one response page.",
                schema: { type: "integer" },
              },
              {
                name: "page_size",
                in: "query",
                description: "Maximum number of resources returned in one response page.",
                schema: { type: "integer" },
              },
            ],
          },
        },
      },
    };

    const content = `
openapi: 3.0.0
paths:
  /v1/resources:
    get:
      parameters: []
`;

    const diags = checkNoRedundantParameters(spec, content, rule);
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("appear to duplicate semantics");
    expect(diags[0].message).toContain("'limit' and 'page_size'");
  });

  test("flags semantic duplicates in request body top-level properties", () => {
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
                    properties: {
                      limit: {
                        type: "integer",
                        description: "Maximum number of resources returned in one response page.",
                      },
                      page_size: {
                        type: "integer",
                        description: "Maximum number of resources returned in one response page.",
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
`;

    const diags = checkNoRedundantParameters(spec, content, rule);
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("requestBody");
    expect(diags[0].message).toContain("'limit' and 'page_size'");
    expect(content.slice(diags[0].from, diags[0].to)).toBe("post");
  });

  test("flags semantic duplicates in response top-level properties", () => {
    const spec: any = {
      openapi: "3.0.0",
      paths: {
        "/v1/resources": {
          get: {
            responses: {
              "200": {
                description: "OK",
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      properties: {
                        request_id: {
                          type: "string",
                          description: "Unique identifier assigned to this request by the service.",
                        },
                        request_identifier: {
                          type: "string",
                          description: "Unique identifier assigned to this request by the service.",
                        },
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
    get:
      responses: {}
`;

    const diags = checkNoRedundantParameters(spec, content, rule);
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("responses:200");
    expect(diags[0].message).toContain("'request_id' and 'request_identifier'");
  });

  test("resolves $ref in parameters and top-level request/response properties", () => {
    const spec: any = {
      openapi: "3.0.0",
      paths: {
        "/v1/resources": {
          post: {
            parameters: [
              { $ref: "#/components/parameters/LimitInQuery" },
            ],
            requestBody: {
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/CreateBody" },
                },
              },
            },
            responses: {
              "200": {
                description: "OK",
                content: {
                  "application/json": {
                    schema: { $ref: "#/components/schemas/CreateResponse" },
                  },
                },
              },
            },
          },
        },
      },
      components: {
        parameters: {
          LimitInQuery: {
            name: "limit",
            in: "query",
            description: "Maximum number of resources returned.",
            schema: { type: "integer" },
          },
        },
        schemas: {
          CreateBody: {
            type: "object",
            properties: {
              resource_name: {
                type: "string",
                description: "Name of the resource to create.",
              },
            },
          },
          CreateResponse: {
            type: "object",
            properties: {
              request_id: {
                type: "string",
                description: "Unique request identifier.",
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
      parameters: []
`;

    const diags = checkNoRedundantParameters(spec, content, rule);
    expect(diags).toHaveLength(0);
  });
});
