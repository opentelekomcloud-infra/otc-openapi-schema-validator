import * as yaml from "js-yaml";
import { prepareOpenApiDocument } from "@/lib/openapi/prepareOpenApiDocument";

describe("prepareOpenApiDocument", () => {
  it("leaves an OpenAPI 3 document unchanged", async () => {
    const content = `openapi: 3.0.1\ninfo:\n  title: Existing\n  version: 1.0.0\npaths: {}\n`;

    await expect(prepareOpenApiDocument(content)).resolves.toEqual({
      content,
      conversion: { converted: false },
    });
  });

  it("converts Swagger 2.0 structures to OpenAPI 3.0.3", async () => {
    const content = `
swagger: "2.0"
info:
  title: Pet API
  version: 1.0.0
host: api.example.com
basePath: /v1
schemes: [https]
consumes: [application/json]
produces: [application/json]
paths:
  /pets:
    post:
      parameters:
        - in: body
          name: pet
          required: true
          schema:
            $ref: "#/definitions/Pet"
      responses:
        "200":
          description: Created
          schema:
            $ref: "#/definitions/Pet"
definitions:
  Pet:
    type: object
    properties:
      name:
        type: string
`.trim();

    const prepared = await prepareOpenApiDocument(content);
    const converted = yaml.load(prepared.content) as any;

    expect(prepared.conversion).toEqual({
      converted: true,
      from: "2.0",
      to: "3.0.3",
    });
    expect(converted.swagger).toBeUndefined();
    expect(converted.openapi).toBe("3.0.3");
    expect(converted.servers).toEqual([{ url: "https://api.example.com/v1" }]);
    expect(converted.components.schemas.Pet).toBeDefined();
    expect(converted.paths["/pets"].post.requestBody.content["application/json"].schema.$ref)
      .toBe("#/components/schemas/Pet");
    expect(converted.paths["/pets"].post.responses["200"].content["application/json"].schema.$ref)
      .toBe("#/components/schemas/Pet");
  });

  it("converts an unquoted numeric Swagger 2.0 version", async () => {
    const content = `
swagger: 2.0
info:
  title: Numeric version
  version: 1.0.0
paths: {}
`.trim();

    const prepared = await prepareOpenApiDocument(content);
    const converted = yaml.load(prepared.content) as any;

    expect(prepared.conversion.converted).toBe(true);
    expect(converted.openapi).toBe("3.0.3");
    expect(converted.swagger).toBeUndefined();
  });

  it("reports conversion errors for malformed Swagger 2 YAML", async () => {
    const content = "swagger: '2.0'\n  invalid indentation";

    await expect(prepareOpenApiDocument(content)).rejects.toThrow(
      "Swagger 2.0 to OpenAPI 3 conversion failed"
    );
  });
});
