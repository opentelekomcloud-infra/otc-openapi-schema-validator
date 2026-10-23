export class NativeExampleError extends Error {
    constructor(readonly pointer: string, detail: string) {
        super(`${detail} at ${pointer}`);
        this.name = "NativeExampleError";
    }
}
