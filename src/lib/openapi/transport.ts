import type { NativeOpenApiDocument, NativeOperation, NativeTransport } from "@/types/openapi";
import { NativeAccessorError } from "./accessorError";
import { getEffectiveStringList, hasOwnField } from "./media";
import { appendPointer, isRecord } from "./references";

export function getNativeTransport(native: NativeOpenApiDocument, operation?: NativeOperation): NativeTransport {
    if (native.dialect === "swagger2") {
        const declaration = getEffectiveStringList(native.document, operation?.operation, "schemes", operation?.pointer);
        return declaration.state === "declared" ? { kind: "schemes", declaration } : { kind: "unspecified" };
    }
    for (const { parent, pointer, level } of [
        { parent: operation?.operation, pointer: operation?.pointer ?? "#", level: "operation" as const },
        { parent: operation?.pathItem, pointer: operation?.resolvedPathItemPointer ?? "#", level: "path" as const },
        { parent: native.document, pointer: "#", level: "root" as const },
    ]) {
        if (!hasOwnField(parent, "servers")) continue;
        const node = parent.servers;
        const sourcePointer = appendPointer(pointer, "servers");
        if (!Array.isArray(node)) {
            throw new NativeAccessorError("INVALID_DECLARATION", sourcePointer, "Expected a servers array");
        }
        const servers = node.map((server: unknown, index: number) => {
            const serverPointer = appendPointer(sourcePointer, index);
            if (!isRecord(server) || typeof server.url !== "string") {
                throw new NativeAccessorError("INVALID_DECLARATION", serverPointer, "Expected a server URL string");
            }
            const scheme = /^([a-z][a-z\d+.-]*):/i.exec(server.url)?.[1].toLowerCase();
            return { node: server, pointer: serverPointer, url: server.url, scheme };
        });
        return { kind: "servers", node, pointer: sourcePointer, level, servers };
    }
    return { kind: "unspecified" };
}
