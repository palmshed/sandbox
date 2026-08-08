# Usage Examples (`examples/`)

This directory contains standalone usage scripts demonstrating Palmshed Sandbox integration across language SDKs and execution backends.

- `quickstart.mjs`: Basic process execution and file manipulation using the reference TypeScript SDK (consumer-facing; imports the installed `@palmshed/sandbox` package).
- `ai-agent-runner.mjs`: Simulates an AI agent executing generated (untrusted) code inside a sandbox with timeout enforcement and streaming output.
- `code-evaluator.mjs`: Simulates a code evaluation system running multiple submissions with pass/fail/timeout collection.
- `ci-runner.mjs`: Simulates a CI build/test environment — uploads a workspace into the sandbox filesystem, runs `npm run build` and `npm test` with streamed output, collects artifacts via `downloadFile`, then exercises a failing workload and a timed-out workload to prove sandbox reuse after both.
- `consumer-test/`: Isolated integration test that verifies the public API against a packed `@palmshed/sandbox` tarball (not workspace source). Run with `consumer-test/run.sh`.

All examples (except `quickstart.mjs`, which requires the installed package) are exercised automatically in CI via `.github/workflows/examples.yml` on Ubuntu, macOS, and Windows.
