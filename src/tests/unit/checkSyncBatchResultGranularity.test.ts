import { checkSyncBatchResultGranularity } from "@/functions/checkSyncBatchResultGranularity";

describe("checkSyncBatchResultGranularity (STS-030-01-2507-2507-M-3)", () => {
  const baseRule: any = {
    id: "STS-030-01-2507-2507-M-3",
    title: "Sync batch result granularity",
    message: "Synchronous batch operations must follow the configured result granularity.",
    severity: "medium",
    call: {
      function: "checkSyncBatchResultGranularity",
      functionParams: {
        batchMatch: {
          keywords: ["batch", "batches", "bulk"],
          pathContainsAny: ["/action"],
          queryFlagsAny: ["delete"],
          requireOneOf: ["keywordMatch", "payloadLooksBatch", "actionPayloadPattern"],
        },
        onlyIfResponseHasContent: true,
        contentTypes: ["application/json", "application/problem+json"],
        mode: "auto",
        perItem: {
          listFieldsAnyOf: ["resources", "items", "results", "statuses"],
          statusFieldsAnyOf: [
            "status",
            "result",
            "state",
            "error_code",
            "errorCode",
            "error_message",
            "errorMessage",
          ],
        },
        allOrNothing: {
          markersAnyOf: ["all_resources_success", "all_resources_failure", "all_success", "all_failure"],
        },
      },
    },
  };

  test("does not flag non-batch operation", () => {
    const spec: any = {
      openapi: "3.0.0",
      paths: {
        "/v1/resources": {
          post: {
            summary: "Create resource",
            requestBody: {
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: { name: { type: "string" } },
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
                      properties: { id: { type: "string" } },
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
      summary: Create resource
      requestBody: {}
      responses:
        "200":
          description: OK
`;

    const diags = checkSyncBatchResultGranularity(spec, content, baseRule);
    expect(diags).toHaveLength(0);
  });

  test("does not flag batch operation when onlyIfResponseHasContent is true and response has no matching content", () => {
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
                    type: "array",
                    items: { type: "object" },
                  },
                },
              },
            },
            responses: {
              "204": { description: "No Content" },
            },
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
      requestBody: {}
      responses:
        "204":
          description: No Content
`;

    const diags = checkSyncBatchResultGranularity(spec, content, baseRule);
    expect(diags).toHaveLength(0);
  });

  test("auto mode flags when all-or-nothing marker is present together with per-item status", () => {
    const spec: any = {
      openapi: "3.0.0",
      paths: {
        "/v1/resources/batch": {
          post: {
            summary: "Delete resources in batches",
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
            responses: {
              "200": {
                description: "OK",
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      properties: {
                        all_success: { type: "boolean" },
                        resources: {
                          type: "array",
                          items: {
                            type: "object",
                            properties: {
                              id: { type: "string" },
                              status: { type: "string" },
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
        },
      },
    };

    const content = `
openapi: 3.0.0
paths:
  /v1/resources/batch:
    post:
      summary: Delete resources in batches
      requestBody: {}
      responses:
        "200":
          description: OK
          content:
            application/json:
              schema:
                type: object
`;

    const diags = checkSyncBatchResultGranularity(spec, content, baseRule);
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("All-or-nothing markers are present");
    expect(content.slice(diags[0].from, diags[0].to)).toBe("post");
  });

  test("auto mode flags when per-item list exists but items have no status field", () => {
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
                    type: "array",
                    items: { type: "object" },
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
                        resources: {
                          type: "array",
                          items: {
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
      requestBody: {}
      responses:
        "200":
          description: OK
          content:
            application/json:
              schema:
                type: object
`;

    const diags = checkSyncBatchResultGranularity(spec, content, baseRule);
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("each item must expose a status field");
  });

  test("auto mode passes when per-item list contains status field", () => {
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
                    type: "array",
                    items: { type: "object" },
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
                        resources: {
                          type: "array",
                          items: {
                            type: "object",
                            properties: {
                              id: { type: "string" },
                              status: { type: "string" },
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
        },
      },
    };

    const content = `
openapi: 3.0.0
paths:
  /v1/resources/batch:
    post:
      summary: Update resources in batches
      requestBody: {}
      responses:
        "200":
          description: OK
          content:
            application/json:
              schema:
                type: object
`;

    const diags = checkSyncBatchResultGranularity(spec, content, baseRule);
    expect(diags).toHaveLength(0);
  });

  test("perItem mode flags when list field is missing", () => {
    const rule = JSON.parse(JSON.stringify(baseRule));
    rule.call.functionParams.mode = "perItem";

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
                    type: "array",
                    items: { type: "object" },
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
                        count: { type: "integer" },
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
  /v1/resources/batch:
    post:
      summary: Update resources in batches
      requestBody: {}
      responses:
        "200":
          description: OK
          content:
            application/json:
              schema:
                type: object
`;

    const diags = checkSyncBatchResultGranularity(spec, content, rule);
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("Expected one of [resources, items, results, statuses] as an array");
  });

  test("allOrNothing mode flags when per-item status is present", () => {
    const rule = JSON.parse(JSON.stringify(baseRule));
    rule.call.functionParams.mode = "allOrNothing";

    const spec: any = {
      openapi: "3.0.0",
      paths: {
        "/v1/resources/batch": {
          post: {
            summary: "Delete resources in batches",
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
            responses: {
              "200": {
                description: "OK",
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      properties: {
                        items: {
                          type: "array",
                          items: {
                            type: "object",
                            properties: {
                              id: { type: "string" },
                              state: { type: "string" },
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
        },
      },
    };

    const content = `
openapi: 3.0.0
paths:
  /v1/resources/batch:
    post:
      summary: Delete resources in batches
      requestBody: {}
      responses:
        "200":
          description: OK
          content:
            application/json:
              schema:
                type: object
`;

    const diags = checkSyncBatchResultGranularity(spec, content, rule);
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("Item-level status must be omitted");
  });
});
