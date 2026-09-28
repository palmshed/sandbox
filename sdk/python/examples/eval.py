"""Tiny Python consumer: the F3 usability proof.

create sandbox, write workload, exec with streaming, wait, inspect the
result, destroy. Run with: PYTHONPATH=src python3 examples/eval.py
"""

import asyncio
import sys

sys.path.insert(0, "src")

from palmshed_sandbox import ExecOptions, Sandbox, SandboxOptions


async def main() -> None:
    sb = await Sandbox.create(SandboxOptions())
    caps = sb.capabilities()
    print(f"capabilities: filesystem={caps.filesystem} streaming={caps.streaming}")

    await sb.write_file("hello.py", b'print("hello from python consumer")')
    ex = await sb.exec("python3 hello.py", ExecOptions())
    print(f"execution: {ex.id} {ex.uri}")
    ex.on_stdout(lambda chunk: print(f"stream: {chunk}", end=""))
    await ex.wait()
    result = ex.result()
    assert result is not None, "result must exist after wait"
    print(f"status={ex.status()} exit={ex.exit_code()} truncated={result.truncated}")
    print(f"stdout={result.stdout!r}")
    await sb.destroy()
    print("destroy ok")


if __name__ == "__main__":
    asyncio.run(main())
