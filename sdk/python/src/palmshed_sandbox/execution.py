"""Live execution handle mirroring TypeScript ``Execution``.

States: running becomes completed, failed, cancelled, or timedout. The
first terminal transition observed by the guard wins: a ``cancelled``
execution is never overwritten by a later natural completion (RFC 0009
section 2.1 as adopted for Python; see discrepancy 001 for the reference
behavior this deliberately does not reproduce).
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator, Awaitable, Callable

from .types import ExecResult, ExecutionMetadata, ExecutionStatus

#: Maximum retained bytes per stream, matching the reference contract.
MAX_RETAINED_BYTES_PER_STREAM = 16 * 1024 * 1024


class _Retained:
    """Bounded output buffer. The owning handle serializes access: drain
    tasks append while the caller reads, so every mutation happens under
    the execution lock."""

    __slots__ = ("chunks", "retained_size", "total_size", "dropped")

    def __init__(self) -> None:
        self.chunks: list[bytes] = []
        self.retained_size = 0
        self.total_size = 0
        self.dropped = False

    def push(self, chunk: bytes) -> None:
        if not chunk:
            return
        size = len(chunk)
        self.total_size += size
        self.chunks.append(chunk)
        self.retained_size += size
        while len(self.chunks) > 1 and self.retained_size > MAX_RETAINED_BYTES_PER_STREAM:
            oldest = self.chunks.pop(0)
            self.retained_size -= len(oldest)
            self.dropped = True
        if len(self.chunks) == 1 and self.retained_size > MAX_RETAINED_BYTES_PER_STREAM:
            # A single over-cap chunk is dropped whole rather than sliced
            # inside a multi-byte character. Its bytes still count.
            self.retained_size = 0
            self.chunks = []
            self.dropped = True

    def text(self) -> str:
        body = b"".join(self.chunks).decode("utf-8", errors="replace")
        if not self.dropped:
            return body
        return (
            f"[output truncated: showing last {self.retained_size} "
            f"of {self.total_size} bytes]\n{body}"
        )


class Execution:
    """Live handle to one running execution. Safe to share across tasks:
    repeated ``wait()`` returns immediately once settled, and every
    accessor serializes through the guard."""

    def __init__(self, execution_id: str) -> None:
        self._id = execution_id
        self._started_at = ""
        self._status = ExecutionStatus.RUNNING
        self._result: ExecResult | None = None
        self._stdout = _Retained()
        self._stderr = _Retained()
        self._stdout_cbs: list[Callable[[str], object]] = []
        self._stderr_cbs: list[Callable[[str], object]] = []
        self._kill: Callable[[], Awaitable[None] | None] | None = None
        self._done = asyncio.Event()

    @property
    def id(self) -> str:
        """Unique execution identifier (``exec_xxxxxxxx``)."""
        return self._id

    @property
    def uri(self) -> str:
        """Stable cross-service URI: ``sandbox://execution/<id>``."""
        return f"sandbox://execution/{self._id}"

    def status(self) -> ExecutionStatus:
        """Current lifecycle state."""
        return self._status

    async def wait(self) -> None:
        """Block until the execution reaches a terminal state. Repeated
        calls return immediately once settled."""
        await self._done.wait()

    def exit_code(self) -> int:
        """Process exit code; -1 while still running."""
        return self._result.exit_code if self._result is not None else -1

    def timed_out(self) -> bool:
        """Whether the execution was terminated by timeout."""
        return self._result.timed_out if self._result is not None else False

    def truncated(self) -> bool:
        """Whether retained output dropped bytes on either stream (sticky)."""
        return self._stdout.dropped or self._stderr.dropped

    def stdout(self) -> str:
        """Retained stdout (bounded; see :meth:`truncated`)."""
        return self._stdout.text()

    def stderr(self) -> str:
        """Retained stderr (bounded)."""
        return self._stderr.text()

    def logs(self) -> str:
        """Retained stdout plus retained stderr."""
        return self._stdout.text() + self._stderr.text()

    def metadata(self) -> ExecutionMetadata | None:
        """Structured execution metadata once settled, else None."""
        return self._result.metadata if self._result is not None else None

    async def stdout_stream(self) -> AsyncIterator[str]:
        """Iterate retained stdout chunks as text. Like the reference
        ``stdoutStream()``, this is a snapshot over retained (bounded)
        output, not a live feed: consume it after ``wait()`` for the
        complete retained text."""
        for chunk in self._stdout.chunks:
            yield chunk.decode("utf-8", errors="replace")

    async def stderr_stream(self) -> AsyncIterator[str]:
        """Iterate retained stderr chunks as text (snapshot; see stdout_stream)."""
        for chunk in self._stderr.chunks:
            yield chunk.decode("utf-8", errors="replace")

    def result(self) -> ExecResult | None:
        """Full raw result once settled, else None."""
        return self._result

    def on_stdout(self, cb: Callable[[str], object]) -> None:
        """Register a real-time stdout callback. Callbacks run on that
        stream's drain task: a blocking callback blocks only its own
        stream, and callbacks for different streams may run on different
        tasks, so they must be thread-safe in effect."""
        self._stdout_cbs.append(cb)

    def on_stderr(self, cb: Callable[[str], object]) -> None:
        """Register a real-time stderr callback (see :meth:`on_stdout`)."""
        self._stderr_cbs.append(cb)

    def _settle(self, status: ExecutionStatus, result: ExecResult) -> None:
        # Guarded single terminal transition: whoever settles first wins.
        # Called synchronously from the backend; never awaits while holding
        # the conceptual lock because settle sites are already serialized.
        if self._status is not ExecutionStatus.RUNNING:
            return
        self._status = status
        self._result = result
        self._done.set()

    async def cancel(self) -> None:
        """Terminate the execution: SIGTERM the tree, then SIGKILL after 1s
        if still running. The cancelled state is terminal; a later natural
        completion never overwrites it. Idempotent."""
        if self._status is not ExecutionStatus.RUNNING:
            return
        self._status = ExecutionStatus.CANCELLED
        kill, self._kill = self._kill, None
        if kill is not None:
            maybe = kill()
            if maybe is not None:
                await maybe
        self._finish_cancelled()

    def _finish_cancelled(self) -> None:
        if self._result is None:
            # A cancelled execution still records what was captured so the
            # result is not None after a terminal transition.
            self._result = ExecResult(
                id=self._id,
                exit_code=-1,
                stdout=self._stdout.text(),
                stderr=self._stderr.text(),
                duration_ms=0,
                timed_out=False,
                truncated=self.truncated(),
                cpu_time_ms=None,
                peak_memory_bytes=None,
                metadata=ExecutionMetadata(
                    id=self._id,
                    backend="native",
                    spec_version="",
                    started_at=self._started_at,
                    finished_at="",
                    duration_ms=0,
                    exit_code=-1,
                    timed_out=False,
                    truncated=self.truncated(),
                ),
            )
        self._done.set()

    def _register_kill(self, kill: Callable[[], Awaitable[None] | None]) -> None:
        self._kill = kill

    def _push_stdout(self, chunk: bytes) -> None:
        self._stdout.push(chunk)
        text = chunk.decode("utf-8", errors="replace")
        for cb in list(self._stdout_cbs):
            cb(text)

    def _push_stderr(self, chunk: bytes) -> None:
        self._stderr.push(chunk)
        text = chunk.decode("utf-8", errors="replace")
        for cb in list(self._stderr_cbs):
            cb(text)
