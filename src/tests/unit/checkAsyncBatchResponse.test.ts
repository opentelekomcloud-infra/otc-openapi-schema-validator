import { checkAsyncBatchResponse } from "@/functions/checkAsyncBatchResponse";

describe("checkAsyncBatchResponse (ASY-010-01-2507-2507-M)", () => {
  const baseRule: any = {
    id: "ASY-010-01-2507-2507-M",
    title: "Async batch response contract",
    message: "Async batch operations must return 202 and include job identifier in response payload.",
    severity: "medium",
    call: {
      function: "checkAsyncBatchResponse",
      functionParams: {
        batchMatch: {
          keywords: ["batch", "batches", "bulk"],
          pathContainsAny: ["/action"],
          queryFlagsAny: ["delete"],
          requireOneOf: ["keywordMatch", "payloadLooksBatch", "actionPayloadPattern"],
        },
        asyncMatch: {
          successStatusCode: "202",
        },
        require: {
          statusCode: "202",
          jobIdAnyOf: ["job_id", "jobId", "task_id", "taskId"],
          resourcesListRequired: false,
          resourcesListAnyOf: ["resources", "items", "results"],
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
            summary: "Create resource asynchronously",
            responses: {
              "202": {
                description: "Accepted",
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      properties: {
                        job_id: { type: "string" },
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
      summary: Create resource asynchronously
      responses:
        "202":
          description: Accepted
`;

    const diags = checkAsyncBatchResponse(spec, content, baseRule);
    expect(diags).toHaveLength(0);
  });

  test("does not flag batch operation when it is not async", () => {
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
                        resources: { type: "array", items: { type: "object" } },
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
`;

    const diags = checkAsyncBatchResponse(spec, content, baseRule);
    expect(diags).toHaveLength(0);
  });

  test("flags async batch when 202 response schema is missing", () => {
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
              "202": {
                description: "Accepted",
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
        "202":
          description: Accepted
`;

    const diags = checkAsyncBatchResponse(spec, content, baseRule);
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("missing a schema");
    expect(content.slice(diags[0].from, diags[0].to)).toBe("post");
  });

  test("flags async batch when job identifier field is missing", () => {
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
              "202": {
                description: "Accepted",
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      properties: {
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
    };

    const content = `
openapi: 3.0.0
paths:
  /v1/resources/batch:
    post:
      summary: Delete resources in batches
      requestBody: {}
      responses:
        "202":
          description: Accepted
          content:
            application/json:
              schema:
                type: object
`;

    const diags = checkAsyncBatchResponse(spec, content, baseRule);
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("job identifier fields");
  });

  test("passes when async batch returns 202 with job_id", () => {
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
                    items: { type: "object" },
                  },
                },
              },
            },
            responses: {
              "202": {
                description: "Accepted",
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      properties: {
                        job_id: { type: "string" },
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
      summary: Create resources in batches
      requestBody: {}
      responses:
        "202":
          description: Accepted
          content:
            application/json:
              schema:
                type: object
`;

    const diags = checkAsyncBatchResponse(spec, content, baseRule);
    expect(diags).toHaveLength(0);
  });

  test("accepts alternative job identifier fields", () => {
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
                    items: { type: "object" },
                  },
                },
              },
            },
            responses: {
              "202": {
                description: "Accepted",
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      properties: {
                        taskId: { type: "string" },
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
      summary: Create resources in batches
      requestBody: {}
      responses:
        "202":
          description: Accepted
          content:
            application/json:
              schema:
                type: object
`;

    const diags = checkAsyncBatchResponse(spec, content, baseRule);
    expect(diags).toHaveLength(0);
  });

  test("flags when resources list is required but missing", () => {
    const rule = JSON.parse(JSON.stringify(baseRule));
    rule.call.functionParams.require.resourcesListRequired = true;

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
                    items: { type: "object" },
                  },
                },
              },
            },
            responses: {
              "202": {
                description: "Accepted",
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      properties: {
                        job_id: { type: "string" },
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
      summary: Create resources in batches
      requestBody: {}
      responses:
        "202":
          description: Accepted
          content:
            application/json:
              schema:
                type: object
`;

    const diags = checkAsyncBatchResponse(spec, content, rule);
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("Expected one of [resources, items, results] as an array");
  });

  test("passes when resources list is required and present", () => {
    const rule = JSON.parse(JSON.stringify(baseRule));
    rule.call.functionParams.require.resourcesListRequired = true;

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
                    items: { type: "object" },
                  },
                },
              },
            },
            responses: {
              "202": {
                description: "Accepted",
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      properties: {
                        job_id: { type: "string" },
                        resources: {
                          type: "array",
                          items: { type: "object" },
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
      summary: Create resources in batches
      requestBody: {}
      responses:
        "202":
          description: Accepted
          content:
            application/json:
              schema:
                type: object
`;

    const diags = checkAsyncBatchResponse(spec, content, rule);
    expect(diags).toHaveLength(0);
  });
});
