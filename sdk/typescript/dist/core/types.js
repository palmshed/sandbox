"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SandboxResourceError = exports.SandboxError = void 0;
class SandboxError extends Error {
    code;
    details;
    constructor(message, code, details) {
        super(message);
        this.code = code;
        this.details = details;
        this.name = 'SandboxError';
    }
}
exports.SandboxError = SandboxError;
class SandboxResourceError extends SandboxError {
    code;
    resource;
    limit;
    observed;
    recoverable;
    constructor(message, code, details) {
        super(message, code, details);
        this.code = code;
        this.name = 'SandboxResourceError';
        this.resource = details.resource;
        this.limit = details.limit;
        this.observed = details.observed;
        this.recoverable = details.recoverable;
    }
}
exports.SandboxResourceError = SandboxResourceError;
