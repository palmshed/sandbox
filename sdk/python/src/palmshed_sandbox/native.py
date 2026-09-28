"""Native backend: local OS process execution (F3 milestone scope).

Implements the specified behavior with plain standard-library glue:
spawn through the platform shell, drain both pipes concurrently, enforce
wall-clock timeout, kill process trees, and contain all filesystem
operations to the sandbox root. Resource budgets, network policies, and
OS-level confinement arrive with later contract ports, not here.
"""

from __future__ import annotations

import asyncio
import datetime
import os
import secrets
import shutil
import signal
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Awaitable, Callable

from .errors import EXEC_FAILED, FS_ERROR, SandboxError
from .execution import Execution
from .types import (
    SPEC_VERSION,
    BackendCapabilities,
    ExecOptions,
    ExecResult,
    ExecutionMetadata,
    ExecutionStatus,
    OsFilesystemIsolation,
    SandboxOptions,
)

#: Windows key set mirroring the reference contract. SystemRoot, ComSpec,
#: and UserProfile are required for the runtime to load at all (a child
#: without SystemRoot aborts on startup); the host environment is still
#: never inherited wholesale. Carried forward from the F1/F2 ports, which
#: found this empirically.
_WINDOWS_ENV_KEYS = (
    "PATH",
    "SystemRoot",
    "ComSpec",
    "USERPROFILE",
    "HOMEDRIVE",
    "HOMEPATH",
    "TEMP",
    "TMP",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
)

_POSIX_ENV_KEYS = (
    "PATH",
    "HOME",
    "TMPDIR",
    "TMP",
    "TEMP",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
)

#: Windows error codes treated as transient (sharing violation, lock
#: violation, access denied while a just-exited child still holds a
#: handle). Carried forward from the F1/F2 ports.
_TRANSIENT_WINERRORS = {5, 32, 33}


def _is_transient(exc: BaseException) -> bool:
    if isinstance(exc, PermissionError):
        return True
    winerror = getattr(exc, "winerror", None)
    return winerror in _TRANSIENT_WINERRORS


async def _retry_io(description: str, op: Callable[[], Awaitable[object] | object]) -> object:
    """Retry an IO callable through transient Windows failures.

    Bounded (5 attempts, linear backoff). Non-transient errors raise
    immediately. Transient failures are never contract failures.
    """
    last: BaseException | None = None
    for attempt in range(5):
        try:
            result = op()
            if asyncio.iscoroutine(result):
                return await result
            return result
        except BaseException as exc:  # noqa: BLE001 - re-raised unless transient
            if not _is_transient(exc):
                raise
            last = exc
            await asyncio.sleep(0.025 * (attempt + 1))
    assert last is not None
    raise last


def _new_exec_id() -> str:
    return "exec_" + secrets.token_hex(4)


def _now_iso() -> str:
    return (
        datetime.datetime.now(datetime.timezone.utc)
        .isoformat(timespec="milliseconds")
        .replace("+00:00", "Z")
    )


def _build_env(sandbox_env: dict[str, str], exec_env: dict[str, str]) -> dict[str, str]:
    keys = _WINDOWS_ENV_KEYS if sys.platform == "win32" else _POSIX_ENV_KEYS
    if sys.platform == "win32":
        present = {k.upper(): v for k, v in os.environ.items()}
        env = {k: present[k.upper()] for k in keys if k.upper() in present}
    else:
        allowed = set(keys)
        env = {k: v for k, v in os.environ.items() if k in allowed}
    env.update(sandbox_env)
    env.update(exec_env)
    return env


def _kill_tree(pid: int) -> None:
    """Terminate a process tree: SIGTERM the group, then SIGKILL after 1s
    on POSIX; taskkill /T /F on Windows. Matches the reference cadence."""
    if sys.platform == "win32":
        subprocess.run(
            ["taskkill", "/pid", str(pid), "/T", "/F"],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
        )
        return
    try:
        os.killpg(pid, signal.SIGTERM)
    except (ProcessLookupError, PermissionError):
        return
    time.sleep(1.0)
    try:
        os.killpg(pid, signal.SIGKILL)
    except (ProcessLookupError, PermissionError):
        pass


class NativeBackend:
    """Local OS process execution backend (F3 milestone scope)."""

    def __init__(self) -> None:
        self._dir: Path | None = None
        self._real_dir: Path | None = None
        self._options = SandboxOptions()
        self._live: set[int] = set()

    @property
    def capabilities(self) -> BackendCapabilities:
        # Enforcement and isolation mechanisms are absent at the F3
        # milestone: reported false/unknown, never implied by the API.
        return BackendCapabilities(
            filesystem=True,
            streaming=True,
            os_filesystem_isolation=OsFilesystemIsolation.UNKNOWN,
        )

    async def init(self, options: SandboxOptions) -> None:
        self._options = options
        prefix = f"palmshed-sandbox-{os.getpid()}-"
        # Unique per sandbox: tempfile gives the random suffix, the pid
        # keeps parallel sandboxes in one host from colliding.
        self._dir = Path(tempfile.mkdtemp(prefix=prefix))
        self._real_dir = self._dir.resolve()

    def _resolve(self, sandbox_path: str) -> Path:
        # Reject absolute host paths cross-platform: a leading slash is
        # absolute on POSIX but not per Windows rules, and drive letters or
        # UNC shares are absolute on Windows but opaque elsewhere. All such
        # spellings are host paths and must be rejected, never silently
        # contained. Matches the reference resolveSandboxPath semantics.
        assert self._real_dir is not None
        p = sandbox_path.replace("\\", "/")
        if p.startswith("/") or (len(p) >= 2 and p[1] == ":" and p[0].isalpha()):
            raise SandboxError(f"absolute host path rejected: {sandbox_path}", FS_ERROR)
        full = (self._real_dir / p.lstrip("/")).resolve(strict=False)
        try:
            full.relative_to(self._real_dir)
        except ValueError:
            raise SandboxError(f"path escapes sandbox root: {sandbox_path}", FS_ERROR) from None
        return full

    async def read_file(self, sandbox_path: str) -> bytes:
        full = self._resolve(sandbox_path)
        # Reject symlink escapes: the canonical path must stay under root.
        try:
            canon = full.resolve(strict=True)
        except OSError as exc:
            raise SandboxError(str(exc), FS_ERROR) from exc
        try:
            canon.relative_to(self._real_dir)
        except ValueError:
            raise SandboxError(f"symlink escape rejected: {sandbox_path}", FS_ERROR)
        try:
            return await _retry_io("read", lambda: _read_bytes(canon))
        except OSError as exc:
            raise SandboxError(str(exc), FS_ERROR) from exc

    async def write_file(self, sandbox_path: str, content: bytes) -> None:
        full = self._resolve(sandbox_path)
        parent = full.parent
        if parent != self._real_dir:
            try:
                await _retry_io("mkdir", lambda: _mkdir_all(parent))
            except OSError as exc:
                raise SandboxError(str(exc), FS_ERROR) from exc
        try:
            await _retry_io("write", lambda: _write_bytes(full, content))
        except OSError as exc:
            raise SandboxError(str(exc), FS_ERROR) from exc

    async def upload_file(self, local_path: str, sandbox_path: str) -> None:
        try:
            with open(local_path, "rb") as fh:
                data = fh.read()
        except OSError as exc:
            raise SandboxError(str(exc), FS_ERROR) from exc
        await self.write_file(sandbox_path, data)

    async def download_file(self, sandbox_path: str, local_path: str) -> None:
        data = await self.read_file(sandbox_path)
        try:
            await _retry_io("download", lambda: _write_bytes(Path(local_path), data))
        except OSError as exc:
            raise SandboxError(str(exc), FS_ERROR) from exc

    async def exec(self, command: str, options: ExecOptions) -> Execution:
        handle = Execution(_new_exec_id())
        handle._started_at = _now_iso()

        if options.work_dir is not None:
            cwd = self._resolve(options.work_dir)
            try:
                await _retry_io("mkdir", lambda: _mkdir_all(cwd))
            except OSError as exc:
                raise SandboxError(str(exc), FS_ERROR) from exc
        else:
            assert self._real_dir is not None
            cwd = self._real_dir

        if sys.platform == "win32":
            popen_args = ["cmd.exe", "/s", "/c", command]
        else:
            popen_args = ["/bin/sh", "-c", command]

        env = _build_env(self._options.env, options.env)
        stdin_data = options.stdin

        proc = await asyncio.create_subprocess_exec(
            *popen_args,
            cwd=str(cwd),
            env=env,
            stdin=asyncio.subprocess.PIPE if stdin_data is not None else asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            start_new_session=(sys.platform != "win32"),
        )
        assert proc.pid is not None
        pid = proc.pid
        self._live.add(pid)

        async def do_kill() -> None:
            await asyncio.to_thread(_kill_tree, pid)
            self._live.discard(pid)

        handle._register_kill(do_kill)
        if options.on_stdout is not None:
            handle.on_stdout(options.on_stdout)
        if options.on_stderr is not None:
            handle.on_stderr(options.on_stderr)

        timeout_ms = options.timeout if options.timeout is not None else (self._options.timeout or 0)
        asyncio.get_running_loop().create_task(
            self._supervise(handle, proc, pid, timeout_ms, stdin_data, options)
        )
        return handle

    async def _supervise(
        self,
        handle: Execution,
        proc: asyncio.subprocess.Process,
        pid: int,
        timeout_ms: int,
        stdin_data: bytes | None,
        options: ExecOptions,
    ) -> None:
        started = time.monotonic()
        started_at = handle._started_at

        async def feed_stdin() -> None:
            # Runs concurrently with the drains so a large stdin cannot
            # deadlock against a child filling its stdout pipe.
            if stdin_data is not None and proc.stdin is not None:
                proc.stdin.write(stdin_data)
                await proc.stdin.drain()
                proc.stdin.close()

        async def drain(stream, push) -> bytes:
            # One task per stream; the process is waited on only after both
            # drains finish, which is what prevents a pipe-buffer deadlock.
            collected = bytearray()
            if stream is None:
                return b""
            while True:
                chunk = await stream.read(8192)
                if not chunk:
                    break
                collected += chunk
                push(chunk)
            return bytes(collected)

        async def run() -> tuple[bytes, bytes, int | None]:
            feed = asyncio.ensure_future(feed_stdin())
            out_task = asyncio.ensure_future(
                drain(proc.stdout, handle._push_stdout)
            )
            err_task = asyncio.ensure_future(
                drain(proc.stderr, handle._push_stderr)
            )
            out, err = await asyncio.gather(out_task, err_task)
            await feed
            code = await proc.wait()
            return out, err, code

        timed_out = False
        run_task = asyncio.ensure_future(run())
        if timeout_ms > 0:
            try:
                out, err, code = await asyncio.wait_for(
                    asyncio.shield(run_task), timeout_ms / 1000
                )
            except asyncio.TimeoutError:
                timed_out = True
                await asyncio.to_thread(_kill_tree, pid)
                self._live.discard(pid)
                out, err, code = await run_task
        else:
            out, err, code = await run_task

        self._live.discard(pid)
        duration_ms = int((time.monotonic() - started) * 1000)
        # Timeout reports -1 regardless of how the process died; signal
        # deaths otherwise report 128 + signal number, matching the
        # reference contract.
        exit_code = -1 if timed_out else (-1 if code is None else code)
        if not timed_out and code is not None and code < 0:
            exit_code = 128 + abs(code)
        truncated = handle.truncated()
        result_metadata = ExecutionMetadata(
            id=handle.id,
            backend="native",
            spec_version=SPEC_VERSION,
            started_at=started_at,
            finished_at=_now_iso(),
            duration_ms=duration_ms,
            exit_code=exit_code,
            timed_out=timed_out,
            truncated=truncated,
        )
        result = ExecResult(
            id=handle.id,
            exit_code=exit_code,
            stdout=out.decode("utf-8", errors="replace"),
            stderr=err.decode("utf-8", errors="replace"),
            duration_ms=duration_ms,
            timed_out=timed_out,
            truncated=truncated,
            cpu_time_ms=None,
            peak_memory_bytes=None,
            metadata=result_metadata,
        )
        if timed_out:
            status = ExecutionStatus.TIMEDOUT
        elif exit_code == 0:
            status = ExecutionStatus.COMPLETED
        else:
            status = ExecutionStatus.FAILED
        handle._settle(status, result)

    async def destroy(self) -> None:
        for pid in list(self._live):
            await asyncio.to_thread(_kill_tree, pid)
        self._live.clear()
        # Retry through transient Windows sharing violations: a just-killed
        # tree can still hold handles inside the workspace for a moment.
        assert self._dir is not None
        target = self._dir
        try:
            await _retry_io("rmtree", lambda: _rmtree(target))
        except FileNotFoundError:
            pass
        except OSError as exc:
            raise SandboxError(str(exc), EXEC_FAILED) from exc


def _read_bytes(path: Path) -> bytes:
    with open(path, "rb") as fh:
        return fh.read()


def _write_bytes(path: Path, data: bytes) -> None:
    with open(path, "wb") as fh:
        fh.write(data)


def _mkdir_all(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)


def _rmtree(path: Path) -> None:
    import shutil

    shutil.rmtree(path, ignore_errors=False)
