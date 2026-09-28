"""Palmshed Sandbox Python SDK (F3).

Implements the sandbox contract from ``spec/`` with its own OS glue and
no Node runtime dependency. Binding rules live in
``rfcs/0011-python-sdk-bindings.md``.
"""

from .errors import (
    EXEC_FAILED,
    FS_ERROR,
    INVALID_BACKEND,
    ResourceError,
    SandboxError,
)
from .execution import MAX_RETAINED_BYTES_PER_STREAM, Execution
from .sandbox import Sandbox
from .types import (
    SPEC_VERSION,
    BackendCapabilities,
    ExecOptions,
    ExecResult,
    ExecutionMetadata,
    ExecutionStatus,
    NetworkPolicy,
    OsFilesystemIsolation,
    ResourceLimits,
    SandboxOptions,
)

__all__ = [
    "EXEC_FAILED",
    "FS_ERROR",
    "INVALID_BACKEND",
    "MAX_RETAINED_BYTES_PER_STREAM",
    "SPEC_VERSION",
    "BackendCapabilities",
    "ExecOptions",
    "ExecResult",
    "Execution",
    "ExecutionMetadata",
    "ExecutionStatus",
    "NetworkPolicy",
    "OsFilesystemIsolation",
    "ResourceError",
    "ResourceLimits",
    "Sandbox",
    "SandboxError",
    "SandboxOptions",
]

__version__ = "0.1.0"
