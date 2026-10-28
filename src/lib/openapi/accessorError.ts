export class NativeAccessorError extends Error {
    constructor(
        readonly code: "INVALID_DECLARATION" | "INVALID_SCHEMA" | "CONFLICTING_PAYLOAD",
        readonly pointer: string,
        detail: string,
    ) {
        super(`${detail} at ${pointer}`);
        this.name = "NativeAccessorError";
    }
}
