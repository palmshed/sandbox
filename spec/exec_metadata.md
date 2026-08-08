# Execution Metadata Contract

Every process execution inside Palmshed Sandbox returns structured metadata:

```json
{
  "id": "exec_9a8b7c6d",
  "backend": "native",
  "specVersion": "1.0.0",
  "startedAt": "2026-08-07T23:55:00.000Z",
  "finishedAt": "2026-08-07T23:55:00.042Z",
  "durationMs": 42,
  "exitCode": 0,
  "timedOut": false
}
```

## First-Class Execution Object Interface

Rather than returning a raw result object, `sandbox.exec()` returns an `Execution` object handle:

```ts
const execution = await sandbox.exec("python3 script.py");

console.log(execution.id);         // Execution UUID
console.log(execution.metadata);   // Full ExecutionMetadata payload
console.log(execution.result());   // Captured ExecResult (stdout, stderr, exitCode)
await execution.cancel();          // Cancel active execution
```
