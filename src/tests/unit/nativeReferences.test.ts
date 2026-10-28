import {
    appendPointer, jsonPointer, NativeReferenceError, resolveObjectReference,
    resolveReference, resolveReferenceNode,
} from "@/lib/openapi/references";
import { resolveLocalRef, resolveRef, resolveRefDeep } from "@/utils/schema";

describe("shared local reference resolution", () => {
    test.each([
        ["definitions"], ["parameters"], ["responses"], ["securityDefinitions"],
        ["components", "schemas"], ["components", "parameters"], ["components", "responses"],
        ["components", "headers"], ["components", "requestBodies"], ["components", "examples"],
        ["components", "securitySchemes"], ["components", "links"], ["components", "callbacks"],
    ])("resolves native reusable container %j", (...tokens: string[]) => {
        const target = Object.freeze({ type: "string" });
        let document: unknown = { Target: target };
        for (const token of [...tokens].reverse()) document = { [token]: document };
        const reference = jsonPointer([...tokens, "Target"]);
        expect(resolveReference(reference, document)).toEqual({ value: target, pointer: reference });
        expect(resolveReference(reference, document).value).toBe(target);
    });

    test.each([
        { reference: "#/a~1b~0c", key: "a/b~c" },
        { reference: "#/~01", key: "~1" },
        { reference: "#/", key: "" },
        { reference: "#/space%20name", key: "space name" },
        { reference: "#/percent%25", key: "percent%" },
        { reference: "#/%E2%82%AC", key: "\u20ac" },
    ])("decodes $reference without losing empty/escaped tokens", ({ reference, key }) => {
        const value = Object.freeze({ type: "integer" });
        const document = Object.freeze({ [key]: value });
        expect(resolveReference(reference, document).value).toBe(value);
    });

    test("retains empty tokens in the middle and at the end of pointers", () => {
        const target = { type: "boolean" };
        expect(resolveReference("#/definitions//", { definitions: { "": { "": target } } }).value).toBe(target);
    });

    test("encodes fragments and supports the root and array element pointers", () => {
        const document = { "a/b~c %": [false] };
        const pointer = jsonPointer(["a/b~c %", 0]);
        expect(pointer).toBe("#/a~1b~0c%20%25/0");
        expect(appendPointer("#/definitions", "a/b")).toBe("#/definitions/a~1b");
        expect(resolveReference(pointer, document).value).toBe(false);
        expect(resolveReference("#", document).value).toBe(document);
    });

    test.each([null, false, 0, ""])("does not mistake a falsy JSON target %j for a missing ref", (value) => {
        expect(resolveReference("#/value", { value }).value).toBe(value);
    });

    test("resolves Map-based legacy inputs using the same pointer implementation", () => {
        const target = { type: "string" };
        const document = new Map([["definitions", new Map([["a/b", target]])]]);
        expect(resolveRef("#/definitions/a~1b", document)).toBe(target);
        expect(resolveLocalRef(document, { $ref: "#/definitions/a~1b" })).toBe(target);
    });

    test("resolves chains, caches final targets and retains target provenance", () => {
        const target = Object.freeze({ type: "object", properties: {} });
        const document = Object.freeze({
            definitions: Object.freeze({
                A: Object.freeze({ $ref: "#/definitions/B" }),
                B: Object.freeze({ $ref: "#/definitions/C" }),
                C: target,
            }),
        });
        const cache = new Map<string, unknown>();
        for (let repeat = 0; repeat < 3; repeat++) {
            expect(resolveReference("#/definitions/A", document, cache)).toEqual({
                value: target, pointer: "#/definitions/C",
            });
            expect(resolveReference("#/definitions/B", document, cache).value).toBe(target);
            expect(resolveRefDeep({ $ref: "#/definitions/A" }, cache, document)).toBe(target);
        }
        expect(resolveRef("#/definitions/A", document)).toBe(target);
        expect(resolveLocalRef(document, { $ref: "#/definitions/A" })).toBe(target);
    });

    test("isolates cache entries even when the same legacy cache is reused across documents", () => {
        const cache = new Map<string, unknown>();
        const first = { definitions: { A: { type: "string" } } };
        const second = { definitions: { A: { type: "integer" } } };
        for (const document of [first, second, first]) {
            expect(resolveReference("#/definitions/A", document, cache).value).toBe(document.definitions.A);
        }
        expect(() => resolveReference("#/definitions/A", {}, cache))
            .toThrow(expect.objectContaining({ code: "UNRESOLVED_REFERENCE" }));
    });

    test("rejects cold and pre-populated circular alias chains without hanging", () => {
        const a = { $ref: "#/definitions/B" };
        const b = { $ref: "#/definitions/A" };
        const document = { definitions: { A: a, B: b, Valid: { type: "string" } } };
        const cache = new Map<string, unknown>([["#/definitions/A", a], ["#/definitions/B", b]]);
        resolveReference("#/definitions/Valid", document, cache);
        for (let repeat = 0; repeat < 3; repeat++) {
            expect(() => resolveRefDeep(a, cache, document))
                .toThrow(expect.objectContaining({ code: "CIRCULAR_REFERENCE" }));
        }
        expect(() => resolveReference("#/definitions/A", document)).toThrow(NativeReferenceError);
        expect(() => resolveReference("#", { $ref: "#" }))
            .toThrow(expect.objectContaining({ code: "CIRCULAR_REFERENCE" }));
    });

    test("does not mistake legitimate recursive properties for circular aliases", () => {
        const node = Object.freeze({
            type: "object",
            properties: Object.freeze({ child: Object.freeze({ $ref: "#/definitions/Node" }) }),
        });
        const document = Object.freeze({ definitions: Object.freeze({ Node: node }) });
        const cache = new Map<string, unknown>();
        expect(resolveReference("#/definitions/Node", document, cache).value).toBe(node);
        expect(resolveReferenceNode(node.properties.child, document, cache).value).toBe(node);
        expect(node.properties.child).toEqual({ $ref: "#/definitions/Node" });
    });

    test.each([
        { reference: "", code: "INVALID_REFERENCE" },
        { reference: "#anchor", code: "INVALID_REFERENCE" },
        { reference: "#/~2", code: "INVALID_REFERENCE" },
        { reference: "#/trailing~", code: "INVALID_REFERENCE" },
        { reference: "#/%ZZ", code: "INVALID_REFERENCE" },
        { reference: "#/missing", code: "UNRESOLVED_REFERENCE" },
        { reference: "#/undefinedValue", code: "UNRESOLVED_REFERENCE" },
        { reference: "other.yaml#/definitions/A", code: "EXTERNAL_REFERENCE" },
        { reference: "https://fixtures.example.invalid/api.json", code: "EXTERNAL_REFERENCE" },
    ])("rejects $reference explicitly as $code", ({ reference, code }) => {
        const document = { undefinedValue: undefined };
        for (const resolve of [
            () => resolveReference(reference, document),
            () => resolveRef(reference, document),
            () => resolveLocalRef(document, { $ref: reference }),
            () => resolveRefDeep({ $ref: reference }, new Map(), document),
        ]) {
            expect(resolve).toThrow(expect.objectContaining({ code }));
        }
    });

    test.each([null, undefined, 2, {}])("rejects non-string $ref %j", ($ref) => {
        expect(() => resolveReferenceNode({ $ref }, {}))
            .toThrow(expect.objectContaining({ code: "INVALID_REFERENCE" }));
    });

    test.each(["length", "01", "-1", "-", "1.0"])("rejects non-index array token %s", (token) => {
        expect(() => resolveReference(`#/values/${token}`, { values: ["x"] }))
            .toThrow(expect.objectContaining({ code: "UNRESOLVED_REFERENCE" }));
    });

    test("does not traverse inherited object properties", () => {
        expect(() => resolveReference("#/constructor/prototype", {}))
            .toThrow(expect.objectContaining({ code: "UNRESOLVED_REFERENCE" }));
        const document: unknown = JSON.parse('{"__proto__":{"value":42}}');
        expect(resolveReference("#/__proto__/value", document).value).toBe(42);
        const inherited = Object.create({ $ref: "#/missing" });
        expect(resolveReferenceNode(inherited, {}).value).toBe(inherited);
    });

    test("preserves non-reference identity and distinguishes object refs from scalar pointers", () => {
        const node = Object.freeze({ type: "string" });
        expect(resolveReferenceNode(node, {}).value).toBe(node);
        expect(resolveObjectReference(node, {})?.value).toBe(node);
        expect(resolveObjectReference(undefined, {})).toBeUndefined();
        expect(() => resolveObjectReference({ $ref: "#/value" }, { value: false }))
            .toThrow(expect.objectContaining({ code: "INVALID_REFERENCE_TARGET" }));
    });

    test("checks sibling policy throughout alias chains, independently of warm default-policy caches", () => {
        const target = { get: {} };
        const document = {
            Alias: { $ref: "#/Target", parameters: [{ name: "q", in: "query" }] },
            Target: target,
        };
        const cache = new Map<string, unknown>();
        expect(resolveReference("#/Alias", document, cache).value).toBe(target);
        expect(() => resolveObjectReference({ $ref: "#/Alias" }, document, cache, "#/paths/~1alias", "reject"))
            .toThrow(expect.objectContaining({ code: "INVALID_REFERENCE", pointer: "#/Alias" }));
    });
});
