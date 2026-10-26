import { NativeAccessorError } from "@/lib/openapi/accessorError";

const token = "[!#$%&'*+.^_`|~0-9A-Za-z-]+";
const quoted = String.raw`"(?:[\t\x20-\x21\x23-\x5b\x5d-\x7e\x80-\xff]|\\[\t\x20-\x7e\x80-\xff])*"`;
const parameter = `[ \\t]*;[ \\t]*(${token})[ \\t]*=[ \\t]*(${token}|${quoted})`;
const mediaType = new RegExp(`^(${token}/${token})((?:${parameter})*)[ \\t]*$`);

export function parseDeclaredMediaType(value: string, pointer: string): {
    readonly base: string; readonly parameters: ReadonlyMap<string, string>;
} {
    const match = mediaType.exec(value);
    if (!match || match[0] !== value) {
        throw new NativeAccessorError("INVALID_DECLARATION", pointer, `Invalid media type: ${value}`);
    }
    const parameters = new Map<string, string>();
    for (const part of match[2].matchAll(new RegExp(parameter, "g"))) {
        const name = part[1].toLowerCase();
        if (parameters.has(name)) {
            throw new NativeAccessorError("INVALID_DECLARATION", pointer, `Duplicate media type parameter: ${name}`);
        }
        const raw = part[2];
        parameters.set(name, raw.startsWith('"') ? raw.slice(1, -1).replace(/\\(.)/g, "$1") : raw);
    }
    return { base: match[1].toLowerCase(), parameters };
}
