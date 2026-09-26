/**
 * Starlark evaluation as an ordinary sandbox workload.
 *
 * This example uses only the generic execution API: the Starlark
 * interpreter is an uploaded executable and the program is an uploaded
 * text file. There is no Starlark concept in the SDK, the spec, or any
 * backend. A future consumer (for example, a policy generator) would
 * follow this same contract: provision interpreter, write program,
 * exec, read result.
 *
 * Required environment:
 *   STARLARK_BIN  path to a starlark interpreter binary for the target
 *                 platform (for example, from `cargo install starlark_bin
 *                 --locked`). The example never downloads or builds it.
 *
 * Optional environment:
 *   BACKEND       `native` (default) or `docker`.
 *   IMAGE         Docker image (default `ubuntu:24.04`). The uploaded
 *                 binary must match the image libc: a binary built on a
 *                 newer glibc fails on older images with a
 *                 `GLIBC_X.XX not found` error. Prefer an image at least
 *                 as new as the build host.
 *
 * Output note: the starlark CLI prints program output (print calls) to
 * stderr and its lint summary (`1 files, 0 errors, ...`) to stdout.
 * This is interpreter behavior, not sandbox behavior, so the example
 * reads the result from stderr deliberately. Timeout, cancellation,
 * and failure use the generic execution semantics unchanged.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Sandbox } from "@palmshed/sandbox";

const here = dirname(fileURLToPath(import.meta.url));
const STARLARK_BIN = process.env.STARLARK_BIN;
const BACKEND = process.env.BACKEND ?? "native";
const IMAGE = process.env.IMAGE ?? "ubuntu:24.04";

if (!STARLARK_BIN) {
  console.error("STARLARK_BIN is required: set it to a local starlark interpreter binary.");
  console.error("Provide one with: cargo install starlark_bin --locked");
  process.exit(2);
}

async function main() {
  const sandbox = await Sandbox.create({
    backend: BACKEND,
    ...(BACKEND === "docker" ? { image: IMAGE } : {}),
    timeout: 30000,
  });

  try {
    // Provision: interpreter binary plus program text, via the VFS.
    await sandbox.uploadFile(STARLARK_BIN, "starlark");
    await sandbox.writeFile("policy.star", readFileSync(join(here, "policy.star"), "utf8"));
    await (await sandbox.exec("chmod +x starlark")).wait();

    // Ordinary execution. Program output arrives on stderr (see note).
    const run = await sandbox.exec("./starlark policy.star");
    await run.wait();
    console.log(`status=${run.status()} exit=${run.exitCode}`);
    console.log(`summary(stdout): ${run.stdout().trim()}`);
    console.log(`result(stderr): ${run.stderr().trim()}`);
    if (run.status() !== "completed") process.exitCode = 1;

    // Failure path: a syntactically invalid program exits nonzero
    // through the same generic failed status.
    await sandbox.writeFile("broken.star", "def f(:\n");
    const broken = await sandbox.exec("./starlark broken.star");
    await broken.wait();
    console.log(`broken: status=${broken.status()} exit=${broken.exitCode}`);
  } finally {
    await sandbox.destroy();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
