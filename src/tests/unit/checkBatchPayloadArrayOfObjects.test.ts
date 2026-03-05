import { checkBatchPayloadArrayOfObjects } from "@/functions/checkBatchPayloadArrayOfObjects";

describe("checkBatchPayloadArrayOfObjects (STS-030-01-2507-2507-M-2)", () => {
  const baseRule: any = {
    id: "STS-030-01-2507-2507-M-2",
    title: "Batch request payload must be array of objects",
    message:
      "Batch operations must specify resources in request body as an array of objects (directly or inside a wrapper).",
    severity: "critical",
    call: {
      function: "checkBatchPayloadArrayOfObjects",
      functionParams: {
        batchMatch: {
          keywords: ["batch", "batches", "bulk"],
          pathContainsAny: ["/action"],
          queryFlagsAny: ["delete"],
          requireOneOf: ["keywordMatch", "payloadLooksBatch", "actionPayloadPattern"],
        },
        payload: {
          allowTopLevelArray: true,
          allowObjectWrapperWithAnyArrayOfObjects: true,
          allowActionEnumCreateDeleteWithTagsArray: true,
          contentTypesPreferred: ["application/json", "application/xml"],
        },
      },
    },
  };

  test("flags batch endpoint when requestBody is missing", () => {
    const spec: any = {
      openapi: "3.0.0",
      paths: {
        "/v1/resources/batch": {
          post: {
            summary: "Create resources in batches",
            responses: { "200": { description: "OK" } },
          },
        },
      },
    };

    const content = `
openapi: 3.0.0
paths:
  /v1/resources/batch:
    post:
      summary: Create resources in batches
      responses: {}
`;

    const diags = checkBatchPayloadArrayOfObjects(spec, content, baseRule);
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain(baseRule.message);
    // Fallback highlight (no requestBody in yaml): should at least highlight method token.
    expect(content.slice(diags[0].from, diags[0].to)).toBe("post");
  });

  test("accepts top-level array<object> payload", () => {
    const spec: any = {
      openapi: "3.0.0",
      paths: {
        "/v1/resources/batch": {
          post: {
            summary: "Create resources in batches",
            requestBody: {
              content: {
                "application/json": {
                  schema: {
                    type: "array",
                    items: { type: "object", properties: { name: { type: "string" } } },
                  },
                },
              },
            },
            responses: { "200": { description: "OK" } },
          },
        },
      },
    };

    const content = `
openapi: 3.0.0
paths:
  /v1/resources/batch:
    post:
      summary: Create resources in batches
      requestBody:
        content:
          application/json:
            schema:
              type: array
      responses: {}
`;

    const diags = checkBatchPayloadArrayOfObjects(spec, content, baseRule);
    expect(diags).toHaveLength(0);
  });

  test("accepts wrapper payload containing any array<object> (e.g. service_items)", () => {
    const spec: any = {
      openapi: "3.0.0",
      paths: {
        "/v1/services/batch": {
          post: {
            summary: "Add service items in batches",
            requestBody: {
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      service_items: {
                        type: "array",
                        items: { type: "object", properties: { id: { type: "string" } } },
                      },
                    },
                  },
                },
              },
            },
            responses: { "200": { description: "OK" } },
          },
        },
      },
    };

    const content = `
openapi: 3.0.0
paths:
  /v1/services/batch:
    post:
      summary: Add service items in batches
      requestBody:
        content:
          application/json:
            schema:
              type: object
      responses: {}
`;

    const diags = checkBatchPayloadArrayOfObjects(spec, content, baseRule);
    expect(diags).toHaveLength(0);
  });

  test("accepts /action payload with action enum(create|delete) + tags: array<object>", () => {
    const spec: any = {
      openapi: "3.0.0",
      paths: {
        "/v1/tags/action": {
          post: {
            summary: "Tags action",
            requestBody: {
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      action: { type: "string", enum: ["create", "delete"] },
                      tags: {
                        type: "array",
                        items: { type: "object", properties: { key: { type: "string" } } },
                      },
                    },
                  },
                },
              },
            },
            responses: { "204": { description: "No Content" } },
          },
        },
      },
    };

    const content = `
openapi: 3.0.0
paths:
  /v1/tags/action:
    post:
      summary: Tags action
      requestBody:
        content:
          application/json:
            schema:
              type: object
              properties:
                action:
                  type: string
                  enum: [create, delete]
                tags:
                  type: array
      responses: {}
`;

    const diags = checkBatchPayloadArrayOfObjects(spec, content, baseRule);
    expect(diags).toHaveLength(0);
  });

  test("does NOT flag /action endpoint when payload is not batch-like and no keyword match", () => {
    const spec: any = {
      openapi: "3.0.0",
      paths: {
        "/v1/resources/action": {
          post: {
            summary: "Do something",
            requestBody: {
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      action: { type: "string" },
                      name: { type: "string" },
                    },
                  },
                },
              },
            },
            responses: { "200": { description: "OK" } },
          },
        },
      },
    };

    const content = `
openapi: 3.0.0
paths:
  /v1/resources/action:
    post:
      summary: Do something
      requestBody:
        content:
          application/json:
            schema:
              type: object
      responses: {}
`;

    const diags = checkBatchPayloadArrayOfObjects(spec, content, baseRule);
    expect(diags).toHaveLength(0);
  });

  test("flags batch endpoint when requestBody exists but is not array<object> nor wrapper nor action+tags", () => {
    const spec: any = {
      openapi: "3.0.0",
      paths: {
        "/v1/resources/batch": {
          post: {
            summary: "Update resources in batches",
            requestBody: {
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      // no array<object> anywhere
                      id: { type: "string" },
                      name: { type: "string" },
                    },
                  },
                },
              },
            },
            responses: { "200": { description: "OK" } },
          },
        },
      },
    };

    const content = `
openapi: 3.0.0
paths:
  /v1/resources/batch:
    post:
      summary: Update resources in batches
      requestBody:
        content:
          application/json:
            schema:
              type: object
      responses: {}
`;

    const diags = checkBatchPayloadArrayOfObjects(spec, content, baseRule);
    expect(diags).toHaveLength(1);
    // Prefer highlighting requestBody keyword when present
    expect(content.slice(diags[0].from, diags[0].to)).toBe("requestBody");
  });

  test("supports XML batch wrapper (e.g. ?delete with nested Object: array<object>)", () => {
    const spec: any = {
      openapi: "3.0.0",
      paths: {
        "/v1/{bucket}?delete": {
          post: {
            summary: "Delete multiple objects",
            requestBody: {
              content: {
                "application/xml": {
                  schema: {
                    type: "object",
                    properties: {
                      Delete: {
                        type: "object",
                        properties: {
                          Object: {
                            type: "array",
                            items: { type: "object", properties: { Key: { type: "string" } } },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
            responses: { "200": { description: "OK" } },
          },
        },
      },
    };

    const content = `
openapi: 3.0.0
paths:
  /v1/{bucket}?delete:
    post:
      summary: Delete multiple objects
      requestBody:
        content:
          application/xml:
            schema:
              type: object
      responses: {}
`;

    const diags = checkBatchPayloadArrayOfObjects(spec, content, baseRule);
    expect(diags).toHaveLength(0);
  });
});
