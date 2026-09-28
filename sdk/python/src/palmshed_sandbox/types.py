"""Public contract types for the Palmshed Sandbox Python SDK (F3).

These map field-for-field to the JSON schemas in ``spec/`` and to the
TypeScript ``core/types.ts`` surface (see
``rfcs/0011-python-sdk-bindings.md``). No Python-only semantic extensions.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Callable

#: Runtime specification version reported in execution metadata.
#: Keep in sync with ``spec/version.md``.
SPEC_VERSION = "1.3.0"


class NetworkPolicy(str, Enum):
    """Network access policy for a sandbox."""

    DISABLED = "disabled"
    ALLOW = "allow"
    PROXY = "proxy"


class OsFilesystemIsolation(str, Enum):
    """RFC 0006 tri-state capability value. Unknown is distinct from
    Unsupported and must never be coerced to a boolean."""

    SUPPORTED = "supported"
    UNSUPPORTED = "unsupported"
    UNKNOWN = "unknown"


class ExecutionStatus(str, Enum):
    """Execution lifecycle state."""

    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"
    TIMEDOUT = "timedout"


@dataclass(frozen=True)
class BackendCapabilities:
    """Backend capability report. Probed at init, never assumed."""

    filesystem: bool = False
    network_isolation: bool = False
    cpu_limits: bool = False
    memory_limits: bool = False
    streaming: bool = False
    os_filesystem_isolation: OsFilesystemIsolation = OsFilesystemIsolation.UNKNOWN
    remote_execution: bool = False
    cpu_quota_limits: bool = False


@dataclass(frozen=True)
class ResourceLimits:
    cpu: float | None = None
    cpu_quota: float | None = None
    cpu_time_limit: int | None = None
    memory: str | None = None
    timeout: int | None = None


@dataclass(frozen=True)
class SandboxOptions:
    """Sandbox creation options. ``None`` means default."""

    backend: str | None = None
    cpu: float | None = None
    cpu_quota: float | None = None
    cpu_time_limit: int | None = None
    memory: str | None = None
    disk_quota: str | None = None
    timeout: int | None = None
    network: NetworkPolicy | None = None
    work_dir: str | None = None
    os_filesystem_isolation: bool | None = None
    env: dict[str, str] = field(default_factory=dict)
    image: str | None = None


@dataclass(frozen=True)
class ExecOptions:
    """Per-execution options. ``None`` means inherit."""

    timeout: int | None = None
    cpu_time_limit: int | None = None
    cpu_quota: float | None = None
    memory: str | None = None
    work_dir: str | None = None
    env: dict[str, str] = field(default_factory=dict)
    #: Standard input bytes fed to the workload, if any.
    stdin: bytes | None = None
    #: Real-time stdout callback (runs on the stream's drain task).
    on_stdout: Callable[[str], object] | None = None
    #: Real-time stderr callback (runs on the stream's drain task).
    on_stderr: Callable[[str], object] | None = None


@dataclass(frozen=True)
class ExecutionMetadata:
    """Structured execution metadata, mirroring ``ExecutionMetadata``."""

    id: str
    backend: str
    spec_version: str
    started_at: str
    finished_at: str
    duration_ms: int
    exit_code: int
    timed_out: bool
    #: Sticky retention-loss flag. ``None`` means unknown, never False.
    truncated: bool | None = None
    #: Best-effort CPU time in ms. ``None`` when unmeasurable.
    cpu_time_ms: float | None = None
    #: Best-effort lower bound on peak memory in bytes.
    peak_memory_bytes: int | None = None


@dataclass(frozen=True)
class ExecResult:
    """Full execution result payload, mirroring ``ExecResult``."""

    id: str
    exit_code: int
    stdout: str
    stderr: str
    duration_ms: int
    timed_out: bool
    truncated: bool | None
    cpu_time_ms: float | None
    peak_memory_bytes: int | None
    metadata: ExecutionMetadata
