import { checkProjectIdByTagScope } from "@/functions/checkProjectIdByTagScope";

describe("checkProjectIdByTagScope (ARG-040-01-2507-2507-O)", () => {
  const rule: any = {
    id: "ARG-040-01-2507-2507-O",
    title: "project_id Path Parameter Scope Consistency",
    message: "The project_id path parameter must be optional only for APIs marked as global services.",
    description:
      "Ensures that project_id usage is consistent with the scope indicated by operation tags. Regional APIs are expected to require project_id, while global APIs may keep it optional.",
    severity: "high",
    call: {
      function: "checkProjectIdByTagScope",
      functionParams: {
        scopeField: "tags",
        scopeTags: {
          global: "global",
          regional: "regional",
        },
        parameterName: "project_id",
        parameterLocation: "path",
        requireForRegional: true,
        optionalForGlobal: true,
        failWhenScopeTagMissing: false,
      },
    },
  };

  test("passes for regional operation with required project_id path parameter", () => {
    const spec: any = {
      openapi: "3.0.0",
      paths: {
        "/v1/{project_id}/resources": {
          get: {
            tags: ["regional"],
            parameters: [
              {
                name: "project_id",
                in: "path",
                required: true,
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
  /v1/{project_id}/resources:
    get:
      tags:
        - regional
`;

    const diags = checkProjectIdByTagScope(spec, content, rule);
    expect(diags).toHaveLength(0);
  });

  test("flags regional operation when project_id path parameter is missing", () => {
    const spec: any = {
      openapi: "3.0.0",
      paths: {
        "/v1/resources": {
          get: {
            tags: ["regional"],
            parameters: [
              {
                name: "limit",
                in: "query",
                required: false,
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
      tags:
        - regional
`;

    const diags = checkProjectIdByTagScope(spec, content, rule);
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("Regional operation must define 'project_id' as 'path' parameter");
    expect(content.slice(diags[0].from, diags[0].to)).toBe("get");
  });

  test("flags regional operation when project_id exists but is not required", () => {
    const spec: any = {
      openapi: "3.0.0",
      paths: {
        "/v1/{project_id}/resources": {
          post: {
            tags: ["regional"],
            parameters: [
              {
                name: "project_id",
                in: "path",
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
  /v1/{project_id}/resources:
    post:
      tags:
        - regional
`;

    const diags = checkProjectIdByTagScope(spec, content, rule);
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("Regional operation must require 'project_id' path parameter");
    expect(content.slice(diags[0].from, diags[0].to)).toBe("post");
  });

  test("passes for global operation without project_id path parameter", () => {
    const spec: any = {
      openapi: "3.0.0",
      paths: {
        "/v1/resources": {
          get: {
            tags: ["global"],
            parameters: [],
          },
        },
      },
    };

    const content = `
openapi: 3.0.0
paths:
  /v1/resources:
    get:
      tags:
        - global
`;

    const diags = checkProjectIdByTagScope(spec, content, rule);
    expect(diags).toHaveLength(0);
  });

  test("passes for global operation when project_id exists and is optional", () => {
    const spec: any = {
      openapi: "3.0.0",
      paths: {
        "/v1/{project_id}/resources": {
          patch: {
            tags: ["global"],
            parameters: [
              {
                name: "project_id",
                in: "path",
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
  /v1/{project_id}/resources:
    patch:
      tags:
        - global
`;

    const diags = checkProjectIdByTagScope(spec, content, rule);
    expect(diags).toHaveLength(0);
  });

  test("flags global operation when project_id exists and is required", () => {
    const spec: any = {
      openapi: "3.0.0",
      paths: {
        "/v1/{project_id}/resources": {
          delete: {
            tags: ["global"],
            parameters: [
              {
                name: "project_id",
                in: "path",
                required: true,
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
  /v1/{project_id}/resources:
    delete:
      tags:
        - global
`;

    const diags = checkProjectIdByTagScope(spec, content, rule);
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("Global operation must not require 'project_id' path parameter");
    expect(content.slice(diags[0].from, diags[0].to)).toBe("delete");
  });

  test("skips operation when scope tags are missing and failWhenScopeTagMissing is false", () => {
    const spec: any = {
      openapi: "3.0.0",
      paths: {
        "/v1/resources": {
          get: {
            tags: ["Propagation"],
            parameters: [],
          },
        },
      },
    };

    const content = `
openapi: 3.0.0
paths:
  /v1/resources:
    get:
      tags:
        - Propagation
`;

    const diags = checkProjectIdByTagScope(spec, content, rule);
    expect(diags).toHaveLength(0);
  });

  test("flags operation when both global and regional tags are present", () => {
    const spec: any = {
      openapi: "3.0.0",
      paths: {
        "/v1/resources": {
          get: {
            tags: ["global", "regional"],
            parameters: [],
          },
        },
      },
    };

    const content = `
openapi: 3.0.0
paths:
  /v1/resources:
    get:
      tags:
        - global
        - regional
`;

    const diags = checkProjectIdByTagScope(spec, content, rule);
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("Operation contains both 'global' and 'regional' scope tags");
    expect(content.slice(diags[0].from, diags[0].to)).toBe("get");
  });

  test("flags missing scope when failWhenScopeTagMissing is true", () => {
    const strictRule = JSON.parse(JSON.stringify(rule));
    strictRule.call.functionParams.failWhenScopeTagMissing = true;

    const spec: any = {
      openapi: "3.0.0",
      paths: {
        "/v1/resources": {
          get: {
            tags: ["Propagation"],
            parameters: [],
          },
        },
      },
    };

    const content = `
openapi: 3.0.0
paths:
  /v1/resources:
    get:
      tags:
        - Propagation
`;

    const diags = checkProjectIdByTagScope(spec, content, strictRule);
    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("Could not determine scope because neither 'global' nor 'regional' tag is present");
  });

  test("resolves $ref path parameters from components", () => {
    const spec: any = {
      openapi: "3.0.0",
      paths: {
        "/v1/{project_id}/resources": {
          get: {
            tags: ["regional"],
            parameters: [
              { $ref: "#/components/parameters/ProjectIdInPath" },
            ],
          },
        },
      },
      components: {
        parameters: {
          ProjectIdInPath: {
            name: "project_id",
            in: "path",
            required: true,
            schema: { type: "string" },
          },
        },
      },
    };

    const content = `
openapi: 3.0.0
paths:
  /v1/{project_id}/resources:
    get:
      tags:
        - regional
      parameters:
        - $ref: '#/components/parameters/ProjectIdInPath'
`;

    const diags = checkProjectIdByTagScope(spec, content, rule);
    expect(diags).toHaveLength(0);
  });

  test("uses path-item level parameters too", () => {
    const spec: any = {
      openapi: "3.0.0",
      paths: {
        "/v1/{project_id}/resources": {
          parameters: [
            {
              name: "project_id",
              in: "path",
              required: true,
              schema: { type: "string" },
            },
          ],
          get: {
            tags: ["regional"],
          },
        },
      },
    };

    const content = `
openapi: 3.0.0
paths:
  /v1/{project_id}/resources:
    get:
      tags:
        - regional
`;

    const diags = checkProjectIdByTagScope(spec, content, rule);
    expect(diags).toHaveLength(0);
  });

  test("treats scope tags case-insensitively", () => {
    const spec: any = {
      openapi: "3.0.0",
      paths: {
        "/v1/{project_id}/resources": {
          get: {
            tags: ["Regional"],
            parameters: [
              {
                name: "project_id",
                in: "path",
                required: true,
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
  /v1/{project_id}/resources:
    get:
      tags:
        - Regional
`;

    const diags = checkProjectIdByTagScope(spec, content, rule);
    expect(diags).toHaveLength(0);
  });
});
