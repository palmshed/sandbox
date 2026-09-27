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

Optional best-effort fields may also be present: `cpuTimeMs` (total CPU
time of the process group in ms) and `peakMemoryBytes` (peak memory
observed during the execution in bytes). `peakMemoryBytes` is a lower
bound, not an exact maximum: Native reports the maximum sampled
process-group RSS (100 ms samples, so sub-interval spikes can be
missed); Docker reports the maximum sampled container memory usage
(1 s samples, container-wide, so concurrent executions in one container
share the reading). The field is absent when no sample succeeded (for
example, an execution shorter than the first sample).

## First-Class Execution Object Interface

Rather than returning a raw result object, `sandbox.exec()` returns an `Execution` object handle:

```ts
const execution = await sandbox.exec("python3 script.py");

console.log(execution.id);         // Execution UUID
console.log(execution.metadata);   // Full ExecutionMetadata payload
console.log(execution.result());   // Captured ExecResult (stdout, stderr, exitCode)
await execution.cancel();          // Cancel active execution
```
