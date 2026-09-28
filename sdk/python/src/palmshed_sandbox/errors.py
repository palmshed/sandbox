"""Error types mirroring the TypeScript ``SandboxError`` contract.

Codes are stable strings shared across SDK implementations:
``EXEC_FAILED``, ``FS_ERROR``, ``INVALID_BACKEND``,
``ERR_CPU_EXCEEDED``, ``ERR_OOM_EXCEEDED``, ``ERR_DISK_QUOTA_EXCEEDED``.
"""

from __future__ import annotations

EXEC_FAILED = "EXEC_FAILED"
FS_ERROR = "FS_ERROR"
INVALID_BACKEND = "INVALID_BACKEND"


class SandboxError(Exception):
    """Base sandbox error with a stable machine-readable code."""

    def __init__(self, message: str, code: str = EXEC_FAILED) -> None:
        super().__init__(message)
        self.code = code

    def __str__(self) -> str:
        return f"{self.code}: {self.args[0]}"


class ResourceError(SandboxError):
    """Structured resource-exhaustion error.

    Recoverable: the sandbox stays usable after one is raised.
    """

    def __init__(
        self,
        code: str,
        resource: str,
        limit: str,
        observed: str | None = None,
    ) -> None:
        super().__init__(f"{resource} limit {limit} exceeded", code)
        self.resource = resource
        self.limit = limit
        self.observed = observed
        self.recoverable = True
