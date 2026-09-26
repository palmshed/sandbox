# Starlark eval (`examples/starlark-eval/`)

A small, real integration example: run Starlark programs as ordinary
sandbox workloads, written against the **published**
`@palmshed/sandbox` package (not workspace internals).

Starlark is not a sandbox concept. The interpreter is an uploaded
executable, the program is an uploaded text file, and execution,
timeout, cancellation, and failure all use the generic API. This
example exists so a future consumer does not have to rediscover the
provisioning and output details.

```sh
cd examples/starlark-eval
npm install   # installs @palmshed/sandbox from the npm registry
STARLARK_BIN=/path/to/starlark npm start
```

Provision the interpreter with (version used for validation: `0.14.2`):

```sh
cargo install starlark_bin --locked
```

What it shows:

- **Provisioning**: binary via `uploadFile`, program via `writeFile`,
  executable bit via `exec("chmod +x ...")`. `STARLARK_BIN` is
  required. Nothing is downloaded or built by the example.
- **Native execution** (default): `BACKEND=native npm start` with a
  host binary.
- **Docker execution** (opt-in): `BACKEND=docker IMAGE=ubuntu:24.04
  STARLARK_BIN=/path/to/linux/starlark npm start`. The binary must
  match the image libc: a binary built against a newer glibc fails on
  older images with a `GLIBC_X.XX not found` error. Prefer an image
  at least as new as the build host.
- **Output handling**: the Starlark CLI prints program output to
  stderr and its lint summary to stdout. The example reads the result
  from stderr deliberately and documents the inversion instead of
  abstracting it away.
- **Failure path**: an invalid program surfaces as the generic
  `failed` status with a nonzero exit code.

This example is documentation, not a gate: CI does not run it. The
packed-artifact examples in `examples/*.mjs` and the consumer suite in
`examples/consumer-test/` cover release validation instead.
