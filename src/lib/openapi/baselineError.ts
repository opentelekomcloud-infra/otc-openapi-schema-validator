export class NativeBaselineError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "NativeBaselineError";
    }
}
