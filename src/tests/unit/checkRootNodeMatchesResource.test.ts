
import { checkRootNodeMatchesResource } from "@/functions/checkRootNodeMatchesResource";

jest.mock("@/utils/englishWords", () => ({
  splitPathIntoTokens: jest.fn((path: string) =>
    String(path)
      .split("/")
      .filter(Boolean)
      .filter((seg) => !/^\{.*\}$/.test(seg))
      .filter((seg) => !/^v\d+(?:\.\d+)?$/i.test(seg))
      .flatMap((seg) => seg.split(/[-_]/g))
      .map((seg) => seg.toLowerCase())
      .filter(Boolean)
  ),
  looksLikeUnknownWord: jest.fn((word: string) => {
    const normalized = String(word).toLowerCase();
    return normalized === "fwinstance" || normalized === "fwinstances";
  }),
}));

describe("checkRootNodeMatchesResource (ARG-060-01-2507-2507-O)", () => {
  const rule: any = {
    id: "ARG-060-01-2507-2507-O",
    title: "Root Body Parameter Should Match Resource Type",
    message: "The root body parameter name should match the resource type, using singular form for single resources and plural form for collections.",
    description:
      "Checks that the top-level request and response body node matches the resource type derived from the path. Collection responses should use plural resource names, while single-resource request/response bodies should use singular names.",
    severity: "medium",
    call: {
      function: "checkRootNodeMatchesResource",
      functionParams: {
        deriveResourceFromPath: true,
        splitPathTokensUsingUtils: true,
        ignorePathVersionTokens: true,
        useEnglishWordValidation: true,
        enforcePluralForCollections: true,
        enforceSingularForSingleResource: true,
        detectCollectionByMethodAndPath: true,
        collectionResponseMethods: ["get"],
        singleResourceRequestMethods: ["post", "put", "patch"],
        ignoreWrapperNames: ["request_id", "page_info", "total_count", "count", "metadata"],
        allowedGenericCollectionWrappers: ["items", "resources", "results"],
        pluralizationMode: "simpleEnglish",
      },
    },
  };

  test("passes for collection GET response with plural resource root", () => {
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
                        users: {
                          type: "array",
                          items: { type: "object" },
                        },
                        page_info: {
                          type: "object",
                        },
                        request_id: {
                          type: "string",
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
  /v1/users:
    get:
      responses: {}
`;

    const diags = checkRootNodeMatchesResource(spec, content, rule);
    expect(diags).toHaveLength(0);
  });

  test("passes for collection GET response with allowed generic wrapper", () => {
    const spec: any = {
      openapi: "3.0.0",
      paths: {
        "/v1/policies": {
          get: {
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
                          items: { type: "object" },
                        },
                        total_count: {
                          type: "integer",
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
  /v1/policies:
    get:
      responses: {}
`;

    const diags = checkRootNodeMatchesResource(spec, content, rule);
    expect(diags).toHaveLength(0);
  });

  test("flags collection GET response when singular root is used", () => {
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
                        user: {
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
  /v1/users:
    get:
      responses: {}
`;

    const diags = checkRootNodeMatchesResource(spec, content, rule);
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("Response body for status '200' should use plural resource name 'users'");
    expect(content.slice(diags[0].from, diags[0].to)).toBe("get");
  });

  test("passes for single-resource GET response with singular root", () => {
    const spec: any = {
      openapi: "3.0.0",
      paths: {
        "/v1/users/{user_id}": {
          get: {
            responses: {
              "200": {
                description: "OK",
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      properties: {
                        user: {
                          type: "object",
                        },
                        request_id: {
                          type: "string",
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
  /v1/users/{user_id}:
    get:
      responses: {}
`;

    const diags = checkRootNodeMatchesResource(spec, content, rule);
    expect(diags).toHaveLength(0);
  });

  test("flags single-resource GET response when plural root is used", () => {
    const spec: any = {
      openapi: "3.0.0",
      paths: {
        "/v1/users/{user_id}": {
          get: {
            responses: {
              "200": {
                description: "OK",
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      properties: {
                        users: {
                          type: "object",
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
  /v1/users/{user_id}:
    get:
      responses: {}
`;

    const diags = checkRootNodeMatchesResource(spec, content, rule);
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("Response body for status '200' should use singular resource name 'user'");
    expect(content.slice(diags[0].from, diags[0].to)).toBe("get");
  });

  test("passes for POST request body with singular root", () => {
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
                      user: {
                        type: "object",
                      },
                      metadata: {
                        type: "object",
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
    post:
      requestBody: {}
`;

    const diags = checkRootNodeMatchesResource(spec, content, rule);
    expect(diags).toHaveLength(0);
  });

  test("flags POST request body when plural root is used", () => {
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
                      users: {
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
    };

    const content = `
openapi: 3.0.0
paths:
  /v1/users:
    post:
      requestBody: {}
`;

    const diags = checkRootNodeMatchesResource(spec, content, rule);
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("Request body root field should use singular resource name 'user'");
    expect(content.slice(diags[0].from, diags[0].to)).toBe("post");
  });

  test("ignores body when only wrapper fields are present", () => {
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
                      metadata: {
                        type: "object",
                      },
                      request_id: {
                        type: "string",
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
    post:
      requestBody: {}
`;

    const diags = checkRootNodeMatchesResource(spec, content, rule);
    expect(diags).toHaveLength(0);
  });

  test("resolves $ref schemas for request and response root properties", () => {
    const spec: any = {
      openapi: "3.0.0",
      paths: {
        "/v1/policies": {
          post: {
            requestBody: {
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/CreatePolicyRequest" },
                },
              },
            },
            responses: {
              "200": {
                description: "OK",
                content: {
                  "application/json": {
                    schema: { $ref: "#/components/schemas/CreatePolicyResponse" },
                  },
                },
              },
            },
          },
        },
      },
      components: {
        schemas: {
          CreatePolicyRequest: {
            type: "object",
            properties: {
              policy: {
                type: "object",
              },
            },
          },
          CreatePolicyResponse: {
            type: "object",
            properties: {
              policy: {
                type: "object",
              },
            },
          },
        },
      },
    };

    const content = `
openapi: 3.0.0
paths:
  /v1/policies:
    post:
      requestBody: {}
      responses: {}
`;

    const diags = checkRootNodeMatchesResource(spec, content, rule);
    expect(diags).toHaveLength(0);
  });

  test("skips strict check for non-dictionary resource tokens when english validation is enabled", () => {
    const spec: any = {
      openapi: "3.0.0",
      paths: {
        "/v1/fwinstance": {
          get: {
            responses: {
              "200": {
                description: "OK",
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      properties: {
                        wrong_root_name: {
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
  /v1/fwinstance:
    get:
      responses: {}
`;

    const diags = checkRootNodeMatchesResource(spec, content, rule);
    expect(diags).toHaveLength(0);
  });
});
