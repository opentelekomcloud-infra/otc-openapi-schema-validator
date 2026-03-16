
import { checkVersionConvention } from "@/functions/checkVersionConvention";

describe("checkVersionConvention (VER-030 shared)", () => {
  const makeRule = (mode: string, overrides: Record<string, any> = {}) => ({
    id: `VER-${mode}`,
    title: "Version Convention",
    message: "Version rule violation.",
    severity: "critical",
    call: {
      function: "checkVersionConvention",
      functionParams: {
        mode,
        ...overrides,
      },
    },
  });

  test("presenceAndPrefix passes for major-only version", () => {
    const spec = {
      openapi: "3.0.0",
      info: {
        title: "Demo API",
        version: "v1",
      },
    };

    const content = `
openapi: 3.0.0
info:
  title: Demo API
  version: v1
`;

    const diags = checkVersionConvention(spec, content, makeRule("presenceAndPrefix", {
      versionPattern: "^v.+$",
    }));

    expect(diags).toHaveLength(0);
  });

  test("presenceAndPrefix fails when version is missing", () => {
    const spec = {
      openapi: "3.0.0",
      info: {
        title: "Demo API",
      },
    };

    const content = `
openapi: 3.0.0
info:
  title: Demo API
`;

    const diags = checkVersionConvention(spec, content, makeRule("presenceAndPrefix", {
      versionPattern: "^v.+$",
    }));

    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("Missing info.version");
  });

  test("presenceAndPrefix fails when version does not start with v", () => {
    const spec = {
      openapi: "3.0.0",
      info: {
        title: "Demo API",
        version: "1",
      },
    };

    const content = `
openapi: 3.0.0
info:
  title: Demo API
  version: 1
`;

    const diags = checkVersionConvention(spec, content, makeRule("presenceAndPrefix", {
      versionPattern: "^v.+$",
    }));

    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("must start with 'v'");
    expect(content.slice(diags[0].from, diags[0].to)).toBe("1");
  });

  test("formatCompliance passes for vX, vX.Y and vX.Y.Z", () => {
    const versions = ["v1", "v1.2", "v1.2.3"];

    for (const version of versions) {
      const spec = {
        openapi: "3.0.0",
        info: {
          title: "Demo API",
          version,
        },
      };

      const content = `
openapi: 3.0.0
info:
  title: Demo API
  version: ${version}
`;

      const diags = checkVersionConvention(spec, content, makeRule("formatCompliance", {
        versionPattern: "^v[0-9]+(\\.[0-9]+)?(\\.[0-9]+)?$",
      }));

      expect(diags).toHaveLength(0);
    }
  });

  test("formatCompliance fails for invalid version format", () => {
    const spec = {
      openapi: "3.0.0",
      info: {
        title: "Demo API",
        version: "v1.beta",
      },
    };

    const content = `
openapi: 3.0.0
info:
  title: Demo API
  version: v1.beta
`;

    const diags = checkVersionConvention(spec, content, makeRule("formatCompliance", {
      versionPattern: "^v[0-9]+(\\.[0-9]+)?(\\.[0-9]+)?$",
    }));

    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("does not match required format");
    expect(content.slice(diags[0].from, diags[0].to)).toBe("v1.beta");
  });

  test("maxSegments passes when segment count is within limit", () => {
    const spec = {
      openapi: "3.0.0",
      info: {
        title: "Demo API",
        version: "v1.2.3",
      },
    };

    const content = `
openapi: 3.0.0
info:
  title: Demo API
  version: v1.2.3
`;

    const diags = checkVersionConvention(spec, content, makeRule("maxSegments", {
      maxVersions: 4,
    }));

    expect(diags).toHaveLength(0);
  });

  test("maxSegments fails when version has too many segments", () => {
    const spec = {
      openapi: "3.0.0",
      info: {
        title: "Demo API",
        version: "v1.2.3.4.5",
      },
    };

    const content = `
openapi: 3.0.0
info:
  title: Demo API
  version: v1.2.3.4.5
`;

    const diags = checkVersionConvention(spec, content, makeRule("maxSegments", {
      maxVersions: 4,
    }));

    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("exceeds the allowed maximum of 4");
  });

  test("maxSegments fails when version string is invalid", () => {
    const spec = {
      openapi: "3.0.0",
      info: {
        title: "Demo API",
        version: "1.2.3",
      },
    };

    const content = `
openapi: 3.0.0
info:
  title: Demo API
  version: 1.2.3
`;

    const diags = checkVersionConvention(spec, content, makeRule("maxSegments", {
      maxVersions: 4,
    }));

    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain("is not a valid version string");
  });

  test("normalization passes for normalized major-only version", () => {
    const spec = {
      openapi: "3.0.0",
      info: {
        title: "Demo API",
        version: "v2",
      },
    };

    const content = `
openapi: 3.0.0
info:
  title: Demo API
  version: v2
`;

    const diags = checkVersionConvention(spec, content, makeRule("normalization", {
      deprecatedPattern: "^v[0-9]+(\\.[0-9]+){1,2}$",
    }));

    expect(diags).toHaveLength(0);
  });

  test("normalization flags non-normalized versions", () => {
    const versions = ["v1.2", "v1.2.3"];

    for (const version of versions) {
      const spec = {
        openapi: "3.0.0",
        info: {
          title: "Demo API",
          version,
        },
      };

      const content = `
openapi: 3.0.0
info:
  title: Demo API
  version: ${version}
`;

      const diags = checkVersionConvention(spec, content, makeRule("normalization", {
        deprecatedPattern: "^v[0-9]+(\\.[0-9]+){1,2}$",
      }));

      expect(diags).toHaveLength(1);
      expect(diags[0].message).toContain("is non-normalized");
      expect(content.slice(diags[0].from, diags[0].to)).toBe(version);
    }
  });

  test("quoted versions are normalized before validation", () => {
    const spec = {
      openapi: "3.0.0",
      info: {
        title: "Demo API",
        version: '"v3.1"',
      },
    };

    const content = `
openapi: 3.0.0
info:
  title: Demo API
  version: "v3.1"
`;

    const diags = checkVersionConvention(spec, content, makeRule("normalization", {
      deprecatedPattern: "^v[0-9]+(\\.[0-9]+){1,2}$",
    }));

    expect(diags).toHaveLength(1);
    expect(diags[0].message).toContain('Version "v3.1" is non-normalized');
  });
});


