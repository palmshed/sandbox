"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SandboxError = void 0;
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
