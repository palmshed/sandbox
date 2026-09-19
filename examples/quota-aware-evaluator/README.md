# Quota-aware evaluator (`examples/quota-aware-evaluator/`)

A small, real integration example: a code evaluation system that caps
untrusted submissions at a CPU quota (`cpuQuota`), written against the
**published** `@palmshed/sandbox` package (not workspace internals).

```sh
cd examples/quota-aware-evaluator
npm install   # installs @palmshed/sandbox from the npm registry
npm start     # runs evaluate.mjs
```

What it shows:

- **Capability discovery**: each sandbox reports `cpuQuotaLimits`; the
  script prints whether the quota is enforced or accepted-but-ignored on
  the current host (Linux with cgroup delegation, Windows with Job
  Objects, and Docker with a supporting daemon enforce it; macOS does
  not). No warnings are emitted for ignored quotas: the flag defines
  that contract.
- **Timeout handling**: throttling stretches wall-clock time, so a wall
  `timeout` tuned for unthrottled execution can fire under quota on
  legitimate work. Wall timeout and CPU-time budget (`cpuTimeLimit`,
  which counts CPU time and is unaffected by throttling) are different
  controls; size timeouts with the quota in mind.
- **Per-execution override**: one execution capped via `cpuQuota` on an
  otherwise quota-less sandbox.

This example is documentation, not a gate: CI does not run it. The
packed-artifact examples in `examples/*.mjs` and the consumer suite in
`examples/consumer-test/` cover release validation instead.
