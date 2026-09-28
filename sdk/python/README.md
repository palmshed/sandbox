# Python SDK (`palmshed-sandbox` 0.1.0)

F3 implementation milestone: the sandbox contract in Python with its own
native OS glue and no Node dependency. Binding rules:
`rfcs/0011-python-sdk-bindings.md`.

## Scope

- Async-first `Sandbox` create/exec/filesystem/destroy; `Execution` live
  handle (status, `wait`, `Done`-equivalent repeated waits, `cancel`,
  callbacks plus async-iterator snapshots, retained output,
  result/metadata).
- Native backend only: spawn, concurrent stdout/stderr drains,
  wall-clock timeout, process-tree termination, contained VFS
  (traversal and symlink-escape rejection), minimal host env.
- `docker` and other backend names fail honestly with
  `INVALID_BACKEND`.

## Current limitations (F3 milestone, not the release)

- No resource sampling or enforcement: `cpu_time_ms` and
  `peak_memory_bytes` stay `None`; cpu/memory/disk/quota options are
  accepted but not enforced (capabilities report `False`).
- No network policies or OS filesystem confinement.
- No synchronous twin API; no PyPI publishing at the milestone.
- Git tags use the `py-` namespace (`py-v0.1.0`) so the Python line
  cannot collide with other SDK tags or trigger the npm pipeline.

## Verify

Requires Python 3.11+ and `pytest` with `pytest-asyncio` (dev-only;
the runtime has no third-party dependencies).

```sh
cd sdk/python
python3 -m pytest tests/ -q
PYTHONPATH=src python3 examples/eval.py
```
