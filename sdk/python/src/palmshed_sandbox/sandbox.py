"""Sandbox facade mirroring TypeScript ``Sandbox``.

Owns one backend instance and forwards the contract surface: create,
capabilities, exec, filesystem operations, destroy. Only the native
backend exists at the F3 milestone; other names fail honestly with
``INVALID_BACKEND``.
"""

from __future__ import annotations

from .errors import INVALID_BACKEND, SandboxError
from .execution import Execution
from .native import NativeBackend
from .types import BackendCapabilities, ExecOptions, SandboxOptions


class Sandbox:
    """Handle to one isolated workspace and its backend."""

    def __init__(self, backend: NativeBackend) -> None:
        self._backend = backend

    @classmethod
    async def create(cls, options: SandboxOptions | None = None) -> Sandbox:
        """Create a sandbox (native backend only at the F3 milestone)."""
        opts = options if options is not None else SandboxOptions()
        name = opts.backend or "native"
        if name != "native":
            raise SandboxError(
                f"backend '{name}' is not available in this SDK build",
                INVALID_BACKEND,
            )
        backend = NativeBackend()
        await backend.init(opts)
        return cls(backend)

    def capabilities(self) -> BackendCapabilities:
        """Backend capability report (probed at init, never assumed)."""
        return self._backend.capabilities

    async def exec(self, command: str, options: ExecOptions | None = None) -> Execution:
        """Execute a command, returning a live :class:`Execution` handle."""
        return await self._backend.exec(command, options if options is not None else ExecOptions())

    async def read_file(self, sandbox_path: str) -> bytes:
        """Read a file from the sandbox filesystem."""
        return await self._backend.read_file(sandbox_path)

    async def write_file(self, sandbox_path: str, content: bytes) -> None:
        """Write a file to the sandbox filesystem."""
        await self._backend.write_file(sandbox_path, content)

    async def upload_file(self, local_path: str, sandbox_path: str) -> None:
        """Copy a host file into the sandbox filesystem."""
        await self._backend.upload_file(local_path, sandbox_path)

    async def download_file(self, sandbox_path: str, local_path: str) -> None:
        """Copy a sandbox file out to the host."""
        await self._backend.download_file(sandbox_path, local_path)

    async def destroy(self) -> None:
        """Destroy the sandbox: kill live trees, remove the workspace."""
        await self._backend.destroy()
