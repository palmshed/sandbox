# Execution Backends (`backends/`)

This directory houses pluggable execution engine drivers implementing the core `BackendEngine` interface defined in `spec/`.

- `native/`: Local OS process isolation reference driver.
- `docker/`: Containerized execution driver.
- `firecracker/`: MicroVM driver (planned, future unit F4).
- `wasi/`: WebAssembly sandbox driver (planned, future unit F5).
