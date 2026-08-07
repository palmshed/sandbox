"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DockerBackend = exports.NativeBackend = void 0;
exports.registerBackend = registerBackend;
exports.createBackend = createBackend;
const native_js_1 = require("./native.js");
const docker_js_1 = require("./docker.js");
const types_js_1 = require("../core/types.js");
const backendRegistry = new Map();
// Register default built-in backends
backendRegistry.set('native', () => new native_js_1.NativeBackend());
backendRegistry.set('docker', () => new docker_js_1.DockerBackend());
function registerBackend(name, factory) {
    backendRegistry.set(name.toLowerCase(), factory);
}
function createBackend(name = 'native') {
    const factory = backendRegistry.get(name.toLowerCase());
    if (!factory) {
        throw new types_js_1.SandboxError(`Unsupported backend '${name}'. Available backends: ${Array.from(backendRegistry.keys()).join(', ')}`, 'INVALID_BACKEND');
    }
    return factory();
}
var native_js_2 = require("./native.js");
Object.defineProperty(exports, "NativeBackend", { enumerable: true, get: function () { return native_js_2.NativeBackend; } });
var docker_js_2 = require("./docker.js");
Object.defineProperty(exports, "DockerBackend", { enumerable: true, get: function () { return docker_js_2.DockerBackend; } });
