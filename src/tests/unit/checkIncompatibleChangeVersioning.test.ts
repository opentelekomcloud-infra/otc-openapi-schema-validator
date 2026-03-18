import { checkIncompatibleChangeVersioning } from "@/functions/checkIncompatibleChangeVersioning";
import * as utilsModule from "@/utils/utils";

jest.mock("@/utils/utils", () => ({
  fetchRepoMap: jest.fn(),
  fetchSpecFromGitea: jest.fn(),
}));

describe("checkIncompatibleChangeVersioning (VER-030-01-2507-2507-O-5)", () => {
  const fetchRepoMapMock = utilsModule.fetchRepoMap as jest.Mock;
  const fetchSpecFromGiteaMock = utilsModule.fetchSpecFromGitea as jest.Mock;

  const rule: any = {
    id: "VER-030-01-2507-2507-O-5",
    title: "Incompatible Changes Versioning",
    message: "For incompatible changes, the version number must be upgraded appropriately.",
    severity: "high",
    call: {
      function: "checkIncompatibleChangeVersioning",
      functionParams: {
        versionPattern: "^v[0-9]+$",
      },
    },
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("returns no diagnostics when repository mapping cannot be resolved", async () => {
    fetchRepoMapMock.mockResolvedValue(null);

    const spec: any = {
      openapi: "3.0.0",
      info: {
        title: "CCE",
        version: "v2",
      },
      paths: {},
    };

    const content = `
openapi: 3.0.0
info:
  title: CCE
  version: v2
`;

    const diags = await checkIncompatibleChangeVersioning(spec, content, rule);

    expect(diags).toHaveLength(0);
    expect(fetchRepoMapMock).toHaveBeenCalledTimes(1);
    expect(fetchSpecFromGiteaMock).not.toHaveBeenCalled();
  });

  test("returns no diagnostics when baseline spec cannot be fetched", async () => {
    fetchRepoMapMock.mockResolvedValue({
      reponame: "cloud-container-engine-baseline-miss",
      filename: "cce_v3_en_baseline_miss",
    });
    fetchSpecFromGiteaMock.mockResolvedValue(null);

    const spec: any = {
      openapi: "3.0.0",
      info: {
        title: "CCE",
        version: "v2",
      },
      paths: {},
    };

    const content = `
openapi: 3.0.0
info:
  title: CCE
  version: v2
`;

    const diags = await checkIncompatibleChangeVersioning(spec, content, rule);

    expect(diags).toHaveLength(0);
    expect(fetchSpecFromGiteaMock).toHaveBeenCalledWith({
      reponame: "cloud-container-engine-baseline-miss",
      filename: "cce_v3_en_baseline_miss",
    });
  });

  test("returns no diagnostics when no breaking changes are detected", async () => {
    fetchRepoMapMock.mockResolvedValue({
      reponame: "enterprise-router-no-breaks",
      filename: "enterprise-router-no-breaks",
    });
    fetchSpecFromGiteaMock.mockResolvedValue({
      openapi: "3.0.0",
      info: {
        title: "ER",
        version: "v1",
      },
      paths: {
        "/v1/resources": {
          get: {
            parameters: [
              { name: "id", in: "query", required: false, schema: { type: "string" } },
            ],
            responses: {
              "200": {
                description: "OK",
                content: {
                  "application/json": {
                    schema: { type: "object" },
                  },
                },
              },
            },
          },
        },
      },
    });

    const spec: any = {
      openapi: "3.0.0",
      info: {
        title: "ER",
        version: "v1",
      },
      paths: {
        "/v1/resources": {
          get: {
            parameters: [
              { name: "id", in: "query", required: false, schema: { type: "string" } },
            ],
            responses: {
              "200": {
                description: "OK",
                content: {
                  "application/json": {
                    schema: { type: "object" },
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
info:
  title: ER
  version: v1
`;

    const diags = await checkIncompatibleChangeVersioning(spec, content, rule);

    expect(diags).toHaveLength(0);
  });

  test("reports one diagnostic per operation when breaking changes exist and major version was not increased", async () => {
    fetchRepoMapMock.mockResolvedValue({
      reponame: "enterprise-router-grouped-breaks",
      filename: "enterprise-router-grouped-breaks",
    });
    fetchSpecFromGiteaMock.mockResolvedValue({
      openapi: "3.0.0",
      info: {
        title: "ER",
        version: "v1",
      },
      paths: {
        "/v1/resources": {
          get: {
            parameters: [
              { name: "id", in: "query", required: false, schema: { type: "string" } },
              { name: "marker", in: "query", required: false, schema: { type: "string" } },
            ],
            responses: {
              "200": {
                description: "OK",
                content: {
                  "application/json": {
                    schema: { type: "object" },
                  },
                },
              },
            },
          },
        },
        "/v1/other": {
          post: {
            responses: {
              "201": {
                description: "Created",
                content: {
                  "application/json": {
                    schema: { type: "object" },
                  },
                },
              },
            },
          },
        },
      },
    });

    const spec: any = {
      openapi: "3.0.0",
      info: {
        title: "ER",
        version: "v1",
      },
      paths: {
        "/v1/resources": {
          get: {
            parameters: [
              { name: "id", in: "query", required: true, schema: { type: "string" } },
            ],
            responses: {
              "200": {
                description: "OK",
                content: {
                  "application/json": {
                    schema: { type: "object" },
                  },
                },
              },
            },
          },
        },
        "/v1/other": {
          post: {
            responses: {
              // removed 201 on purpose
            },
          },
        },
      },
    };

    const content = `
openapi: 3.0.0
info:
  title: ER
  version: v1
`;

    const diags = await checkIncompatibleChangeVersioning(spec, content, rule);

    expect(diags).toHaveLength(2);
    expect(diags.every((d) => content.slice(d.from, d.to) === "v1")).toBe(true);
    expect(diags.some((d) => d.message.includes("GET /v1/resources"))).toBe(true);
    expect(diags.some((d) => d.message.includes("POST /v1/other"))).toBe(true);
    expect(diags.some((d) => d.message.includes("major version was not increased"))).toBe(true);
  });

  test("does not report diagnostics when breaking changes exist but major version was increased", async () => {
    fetchRepoMapMock.mockResolvedValue({
      reponame: "enterprise-router-major-up",
      filename: "enterprise-router-major-up",
    });
    fetchSpecFromGiteaMock.mockResolvedValue({
      openapi: "3.0.0",
      info: {
        title: "ER",
        version: "v1",
      },
      paths: {
        "/v1/resources": {
          get: {
            parameters: [
              { name: "id", in: "query", required: false, schema: { type: "string" } },
            ],
            responses: {
              "200": {
                description: "OK",
                content: {
                  "application/json": {
                    schema: { type: "object" },
                  },
                },
              },
            },
          },
        },
      },
    });

    const spec: any = {
      openapi: "3.0.0",
      info: {
        title: "ER",
        version: "v2",
      },
      paths: {
        "/v1/resources": {
          get: {
            parameters: [],
            responses: {
              "200": {
                description: "OK",
                content: {
                  "application/json": {
                    schema: { type: "object" },
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
info:
  title: ER
  version: v2
`;

    const diags = await checkIncompatibleChangeVersioning(spec, content, rule);

    expect(diags).toHaveLength(0);
  });

  test("detects removed referenced parameters as breaking changes", async () => {
    fetchRepoMapMock.mockResolvedValue({
      reponame: "enterprise-router-ref-param-removal",
      filename: "enterprise-router-ref-param-removal",
    });
    fetchSpecFromGiteaMock.mockResolvedValue({
      openapi: "3.0.0",
      info: {
        title: "ER",
        version: "v1",
      },
      paths: {
        "/v3/{project_id}/enterprise-router/{er_id}/route-tables/{route_table_id}/propagations": {
          get: {
            parameters: [
              { $ref: "#/components/parameters/ContentTypeInHeader" },
              { $ref: "#/components/parameters/ErIdInPath" },
            ],
            responses: {
              "200": {
                description: "OK",
                content: {
                  "application/json": {
                    schema: { type: "object" },
                  },
                },
              },
            },
          },
        },
      },
      components: {
        parameters: {
          ContentTypeInHeader: {
            name: "Content-Type",
            in: "header",
            required: false,
            schema: { type: "string" },
          },
          ErIdInPath: {
            name: "er_id",
            in: "path",
            required: true,
            schema: { type: "string" },
          },
        },
      },
    });

    const spec: any = {
      openapi: "3.0.0",
      info: {
        title: "ER",
        version: "v1",
      },
      paths: {
        "/v3/{project_id}/enterprise-router/{er_id}/route-tables/{route_table_id}/propagations": {
          get: {
            parameters: [
              { $ref: "#/components/parameters/ContentTypeInHeader" },
            ],
            responses: {
              "200": {
                description: "OK",
                content: {
                  "application/json": {
                    schema: { type: "object" },
                  },
                },
              },
            },
          },
        },
      },
      components: {
        parameters: {
          ContentTypeInHeader: {
            name: "Content-Type",
            in: "header",
            required: false,
            schema: { type: "string" },
          },
          ErIdInPath: {
            name: "er_id",
            in: "path",
            required: true,
            schema: { type: "string" },
          },
        },
      },
    };

    const content = `
openapi: 3.0.0
info:
  title: ER
  version: v1
`;

    const diags = await checkIncompatibleChangeVersioning(spec, content, rule);

    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("GET /v3/{project_id}/enterprise-router/{er_id}/route-tables/{route_table_id}/propagations");
    expect(diags[0].message).toContain("Parameter 'path:er_id' was removed");
  });

  test("reports diagnostic when major versions cannot be compared reliably", async () => {
    fetchRepoMapMock.mockResolvedValue({
      reponame: "enterprise-router-uncomparable-version",
      filename: "enterprise-router-uncomparable-version",
    });
    fetchSpecFromGiteaMock.mockResolvedValue({
      openapi: "3.0.0",
      info: {
        title: "ER",
        version: "v1",
      },
      paths: {
        "/v1/resources": {
          get: {
            parameters: [
              { name: "id", in: "query", required: false, schema: { type: "string" } },
            ],
            responses: {
              "200": {
                description: "OK",
                content: {
                  "application/json": {
                    schema: { type: "object" },
                  },
                },
              },
            },
          },
        },
      },
    });

    const spec: any = {
      openapi: "3.0.0",
      info: {
        title: "ER",
        version: "beta",
      },
      paths: {
        "/v1/resources": {
          get: {
            parameters: [],
            responses: {
              "200": {
                description: "OK",
                content: {
                  "application/json": {
                    schema: { type: "object" },
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
info:
  title: ER
  version: beta
`;

    const diags = await checkIncompatibleChangeVersioning(spec, content, rule);

    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("Could not compare major versions reliably");
    expect(content.slice(diags[0].from, diags[0].to)).toBe("beta");
  });
});
