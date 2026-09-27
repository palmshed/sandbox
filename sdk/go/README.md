# Go SDK (`github.com/palmshed/sandbox/sdk/go` 0.1.0)

F2 implementation milestone: the sandbox contract in Go with its own
native OS glue and no Node dependency. Binding rules:
`rfcs/0009-go-sdk-bindings.md`.

## Scope

- `Sandbox` create/exec/filesystem/destroy; `Execution` live handle
  (status, `Wait`/`Done`, `Cancel`, callbacks, retained output,
  result/metadata).
- Native backend only: spawn, concurrent stdout/stderr drains,
  wall-clock timeout, process-tree termination, contained VFS
  (traversal and symlink-escape rejection), minimal host env.
- `docker` and other backend names fail honestly with `INVALID_BACKEND`.

## Current limitations (F2 milestone, not the release)

- No resource sampling or enforcement: `CPUTimeMs` and
  `PeakMemoryBytes` are nil; cpu/memory/disk/quota options are accepted
  but not enforced (capabilities report false).
- No network policies or OS filesystem confinement.
- Not published to a public module proxy.
- Git tags use the `go-` namespace (`go-v0.1.0`) so the Go line cannot
  collide with the TypeScript (`v1.x`) or Rust (`v0.x`) tag namespaces
  and cannot trigger the npm release pipeline.

## Verify

```sh
cd sdk/go
go test -race ./...
go run ./cmd/consumer
```
