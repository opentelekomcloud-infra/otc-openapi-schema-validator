import type { NativeOpenApiDocument } from "@/types/openapi";
import { fetchRepoMap, fetchSpecFromGitea } from "@/utils/utils";
import { executionContextFor, type NativeExecutionContext } from "./executionContext";
import { classifyNativeOpenApiDocument } from "./parseNativeOpenApi";
import { BaselineUnavailableError, NativeBaselineError } from "./baselineError";
import { isRecord } from "./references";

const baselines = new WeakMap<NativeExecutionContext, Promise<NativeOpenApiDocument>>();

class GiteaUnavailableError extends BaselineUnavailableError {}

export async function checkGiteaAvailability(signal: AbortSignal): Promise<void> {
    const response = await fetch("/api/gitea-status", { signal, cache: "no-store" });
    const data: unknown = await response.json();
    if (!response.ok || !isRecord(data) || data.available !== true) {
        throw new Error("Could not connect to Gitea.");
    }
}

export function createBaselineSession(
    onUnavailable: (message: string) => void,
    probe?: (signal: AbortSignal) => Promise<void>,
) {
    let unavailable: GiteaUnavailableError | null = null;
    let generation = 0;
    let checking = Boolean(probe);
    function reset() {
        generation += 1;
        unavailable = null;
        checking = false;
    }
    return {
        get checking() { return checking; },
        async check(signal: AbortSignal): Promise<void> {
            reset();
            checking = true;
            const attempt = generation;
            try {
                await probe?.(signal);
                if (attempt === generation) checking = false;
            } catch {
                if (attempt !== generation) return;
                checking = false;
                unavailable = new GiteaUnavailableError(signal.aborted
                    ? "Gitea availability check timed out after 5 seconds."
                    : "Could not connect to Gitea.");
                onUnavailable(unavailable.message);
            }
        },
        async load(document: unknown): Promise<NativeOpenApiDocument> {
            if (checking) throw new BaselineUnavailableError("Gitea connection is being checked. Baseline check temporarily skipped.");
            if (unavailable) throw unavailable;
            const attempt = generation;
            try {
                return await loadBaseline(document);
            } catch (error: unknown) {
                if (error instanceof GiteaUnavailableError && attempt === generation && unavailable === null) {
                    unavailable = error;
                    onUnavailable(error.message);
                }
                throw error;
            }
        },
        reset,
    };
}

export function readBaseline<T>(read: () => T): T {
    try {
        return read();
    } catch (error) {
        // Baseline pointers belong to a different source document.
        throw new NativeBaselineError(`Cannot inspect baseline: ${error instanceof Error ? error.message : String(error)}`);
    }
}

async function loadBaseline(document: unknown): Promise<NativeOpenApiDocument> {
    const repo = await fetchRepoMap(document);
    if (!repo) throw new BaselineUnavailableError("Baseline repository mapping is unavailable for this specification.");
    const baseline: unknown = await fetchSpecFromGitea(repo);
    if (baseline == null) throw new GiteaUnavailableError("Baseline specification could not be loaded from Gitea.");
    try {
        return classifyNativeOpenApiDocument(baseline);
    } catch (error) {
        throw new NativeBaselineError(`Invalid baseline specification: ${error instanceof Error ? error.message : String(error)}`);
    }
}

export function nativeBaseline(document: unknown): Promise<NativeOpenApiDocument> {
    const context = executionContextFor(document);
    if (!context) return loadBaseline(document);
    let pending = baselines.get(context);
    if (!pending) {
        pending = context.loadBaseline ? context.loadBaseline(document) : loadBaseline(document);
        baselines.set(context, pending);
    }
    return pending;
}
