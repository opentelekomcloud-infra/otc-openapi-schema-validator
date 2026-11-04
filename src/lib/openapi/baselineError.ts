export class NativeBaselineError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "NativeBaselineError";
    }
}

export class BaselineUnavailableError extends NativeBaselineError {
    constructor(message: string) {
        super(message);
        this.name = "BaselineUnavailableError";
    }
}
