import { checkBatchUsesPost } from "@/functions/checkBatchUsesPost";


describe("checkBatchUsesPost (STS-030-01-2507-2507-M-1)", () => {
  const baseRule: any = {
    id: "STS-030-01-2507-2507-M-1",
    title: "Batch Resource Operations",
    message: "Batch resource operations must use POST.",
    severity: "critical",
    call: {
      function: "checkBatchUsesPost",
      functionParams: {
        methodsToScan: ["get", "post", "put", "patch", "delete"],
        batchMatch: {
          keywords: ["batch", "batches", "bulk"],
          pathContainsAny: ["/action"],
          queryFlagsAny: ["delete"],
          requireOneOf: ["keywordMatch", "payloadLooksBatch", "actionPayloadPattern"],
        },
        allowedMethods: ["post"],
      },
    },
  };

  test("flags a keyword-matched batch endpoint when method is not POST", () => {
    const spec: any = {
      openapi: "3.0.0",
      paths: {
        "/v1/resources/batch": {
          put: {
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
    put:
      summary: Create resources in batches
      requestBody: {}
      responses: {}
`;

    const diags = checkBatchUsesPost(spec, content, baseRule);
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("Batch resource operations must use POST");
    expect(content.slice(diags[0].from, diags[0].to)).toBe("put");
  });

  test("flags an /action endpoint with action+tags payload when method is not POST", () => {
    const spec: any = {
      openapi: "3.0.0",
      paths: {
        "/v1/tags/action": {
          delete: {
            summary: "Tags action",
            requestBody: {
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      action: { type: "string", enum: ["delete"] },
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
    delete:
      summary: Tags action
      requestBody:
        content:
          application/json:
            schema:
              type: object
              properties:
                action:
                  type: string
                  enum: [delete]
                tags:
                  type: array
                  items:
                    type: object
      responses: {}
`;

    const diags = checkBatchUsesPost(spec, content, baseRule);
    expect(diags).toHaveLength(1);
    expect(content.slice(diags[0].from, diags[0].to)).toBe("delete");
  });

  test("does NOT flag an /action endpoint when payload does not look batch-like and no keyword match", () => {
    const spec: any = {
      openapi: "3.0.0",
      paths: {
        "/v1/resources/action": {
          put: {
            summary: "Do something",
            requestBody: {
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      // Not a tags batch, and no array<object> anywhere
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
    put:
      summary: Do something
      requestBody: {}
      responses: {}
`;

    const diags = checkBatchUsesPost(spec, content, baseRule);
    expect(diags).toHaveLength(0);
  });

  test("flags an OBS-style ?delete endpoint when payload wrapper contains array<object> and method is not POST", () => {
    const spec: any = {
      openapi: "3.0.0",
      paths: {
        "/v1/{bucket}?delete": {
          put: {
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
    put:
      summary: Delete multiple objects
      requestBody: {}
      responses: {}
`;

    const diags = checkBatchUsesPost(spec, content, baseRule);
    expect(diags).toHaveLength(1);
    expect(content.slice(diags[0].from, diags[0].to)).toBe("put");
  });

  test("respects allowedMethods override", () => {
    const rule = JSON.parse(JSON.stringify(baseRule));
    rule.call.functionParams.allowedMethods = ["post", "put"];

    const spec: any = {
      openapi: "3.0.0",
      paths: {
        "/v1/resources/batch": {
          put: {
            summary: "Create resources in batches",
            requestBody: {
              content: {
                "application/json": {
                  schema: {
                    type: "array",
                    items: { type: "object" },
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
    put:
      summary: Create resources in batches
      requestBody: {}
      responses: {}
`;

    const diags = checkBatchUsesPost(spec, content, rule);
    expect(diags).toHaveLength(0);
  });
});
