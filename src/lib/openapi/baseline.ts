import type { NativeOpenApiDocument } from "@/types/openapi";
import { fetchRepoMap, fetchSpecFromGitea } from "@/utils/utils";
import { executionContextFor, type NativeExecutionContext } from "./executionContext";
import { classifyNativeOpenApiDocument } from "./parseNativeOpenApi";

const baselines = new WeakMap<NativeExecutionContext, Promise<NativeOpenApiDocument>>();

export function readBaseline<T>(read: () => T): T {
    try {
        return read();
    } catch (error) {
        // Baseline pointers belong to a different source document.
        throw new Error(`Cannot inspect baseline: ${error instanceof Error ? error.message : String(error)}`);
    }
}

async function loadBaseline(document: unknown): Promise<NativeOpenApiDocument> {
    const repo = await fetchRepoMap(document);
    if (!repo) throw new Error("Baseline repository mapping is unavailable for this specification.");
    const baseline: unknown = await fetchSpecFromGitea(repo);
    if (baseline == null) throw new Error("Baseline specification could not be loaded from Gitea.");
    try {
        return classifyNativeOpenApiDocument(baseline);
    } catch (error) {
        throw new Error(`Invalid baseline specification: ${error instanceof Error ? error.message : String(error)}`);
    }
}

export function nativeBaseline(document: unknown): Promise<NativeOpenApiDocument> {
    const context = executionContextFor(document);
    if (!context) return loadBaseline(document);
    let pending = baselines.get(context);
    if (!pending) {
        pending = loadBaseline(document);
        baselines.set(context, pending);
    }
    return pending;
}
