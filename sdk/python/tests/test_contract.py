"""Normative contract tests ported from the TypeScript compliance suite.

Each case preserves the expected semantics of its source assertion
(``compliance/sdk/suite.test.js``,
``compliance/backends/native.test.js``). Anything asserted here must hold
in every SDK; platform-divergent behavior skips with a reason, never
weakened to pass.
"""

import asyncio
import os
import sys

import pytest

from palmshed_sandbox import (
    SPEC_VERSION,
    ExecOptions,
    ExecutionStatus,
    OsFilesystemIsolation,
    Sandbox,
    SandboxError,
    SandboxOptions,
)

pytestmark = pytest.mark.asyncio


async def _new_sandbox(**kwargs):
    return await Sandbox.create(SandboxOptions(**kwargs))


async def test_execution_handle_uri_and_initial_status():
    sb = await _new_sandbox()
    try:
        ex = await sb.exec('echo "Compliance"')
        assert ex.id.startswith("exec_")
        assert ex.uri.startswith("sandbox://execution/exec_")
        assert ex.status() == ExecutionStatus.RUNNING
        await ex.wait()
        assert ex.status() == ExecutionStatus.COMPLETED
    finally:
        await sb.destroy()


async def test_command_execution_and_exit_code():
    sb = await _new_sandbox()
    try:
        ex = await sb.exec('echo "Compliance Test"')
        await ex.wait()
        assert ex.exit_code() == 0
        assert isinstance(ex.stdout(), str)
        assert ex.timed_out() is False
    finally:
        await sb.destroy()


async def test_execution_metadata():
    sb = await _new_sandbox()
    try:
        ex = await sb.exec('echo "Metadata"')
        await ex.wait()
        meta = ex.metadata()
        assert meta is not None
        assert meta.backend == "native"
        assert meta.spec_version == SPEC_VERSION == "1.3.0"
        # ISO-8601 UTC with millis, matching the reference shape exactly.
        for stamp in (meta.started_at, meta.finished_at):
            assert stamp.endswith("Z"), stamp
            assert len(stamp) == 24, stamp
    finally:
        await sb.destroy()


async def test_realtime_stdout_streaming():
    sb = await _new_sandbox()
    try:
        ex = await sb.exec('echo "Stream Chunk"')
        captured: list[str] = []
        ex.on_stdout(captured.append)
        await ex.wait()
        assert "Stream Chunk" in "".join(captured)
    finally:
        await sb.destroy()


async def test_timeout_enforcement_and_timedout_status():
    sb = await _new_sandbox()
    try:
        await sb.write_file("spin.py", b"import time; time.sleep(5)")
        ex = await sb.exec("python3 spin.py", ExecOptions(timeout=150))
        await ex.wait()
        assert ex.status() == ExecutionStatus.TIMEDOUT
        assert ex.exit_code() == -1
        assert ex.metadata() is not None
        assert ex.metadata().timed_out is True
    finally:
        await sb.destroy()


async def test_failing_command_reports_failed():
    sb = await _new_sandbox()
    try:
        ex = await sb.exec("exit 3")
        await ex.wait()
        assert ex.status() == ExecutionStatus.FAILED
        assert ex.exit_code() == 3
    finally:
        await sb.destroy()


async def test_capability_negotiation_flags():
    sb = await _new_sandbox()
    try:
        caps = sb.capabilities()
        assert caps.filesystem is True
        assert caps.streaming is True
        assert caps.remote_execution is False
        assert caps.os_filesystem_isolation in (
            OsFilesystemIsolation.SUPPORTED,
            OsFilesystemIsolation.UNSUPPORTED,
            OsFilesystemIsolation.UNKNOWN,
        )
        # Enforcement capabilities are absent at this milestone and must be
        # reported False, never True because the option exists.
        assert caps.cpu_limits is False
        assert caps.memory_limits is False
        assert caps.cpu_quota_limits is False
    finally:
        await sb.destroy()


async def test_vfs_isolation_boundary():
    sb = await _new_sandbox()
    try:
        with pytest.raises(SandboxError) as exc:
            await sb.read_file("../../../../etc/hosts")
        assert exc.value.code == "FS_ERROR"
        with pytest.raises(SandboxError) as exc:
            await sb.write_file("/etc/evil.txt", b"x")
        assert exc.value.code == "FS_ERROR"
        # Absolute spellings rejected on every platform (leading slash is
        # not absolute per Windows rules, so the check is spelled out).
        for p in ("C:/Windows/evil.txt", "C:\\Windows\\evil.txt", "\\\\srv\\share\\x"):
            with pytest.raises(SandboxError) as exc:
                await sb.write_file(p, b"x")
            assert exc.value.code == "FS_ERROR"
        if sys.platform == "win32":
            pytest.skip("symlink escape assertion is POSIX-only")
        await sb.write_file("plant.js", b"require('fs').symlinkSync('/etc/hosts','link.txt')")
        plant = await sb.exec("node plant.js")
        await plant.wait()
        with pytest.raises(SandboxError) as exc:
            await sb.read_file("link.txt")
        assert exc.value.code == "FS_ERROR"
    finally:
        await sb.destroy()


async def test_environment_contract():
    os.environ["HOST_LEAK_VAR"] = "should-not-leak"
    try:
        sb = await Sandbox.create(SandboxOptions(env={"EXPLICIT_VAR": "injected"}))
    finally:
        del os.environ["HOST_LEAK_VAR"]
    try:
        await sb.write_file(
            "env.js",
            b"console.log((process.env.HOST_LEAK_VAR||'absent') + ' ' + "
            b"(process.env.EXPLICIT_VAR||'absent') + ' ' + "
            b"(process.env.PATH?'path':'nopath'))",
        )
        ex = await sb.exec("node env.js")
        await ex.wait()
        assert ex.exit_code() == 0
        assert "absent injected path" in ex.stdout()
    finally:
        await sb.destroy()


async def test_unknown_backend_fails_honestly():
    with pytest.raises(SandboxError) as exc:
        await Sandbox.create(SandboxOptions(backend="firecracker"))
    assert exc.value.code == "INVALID_BACKEND"


async def test_filesystem_round_trip():
    sb = await _new_sandbox()
    try:
        await sb.write_file("sub/dir.txt", b"data")
        assert await sb.read_file("sub/dir.txt") == b"data"
    finally:
        await sb.destroy()


# ---- Python-specific contract behavior (RFC 0011 sections 2-3) ----


async def test_guarded_terminal_state_cancel_is_terminal():
    sb = await _new_sandbox()
    try:
        ex = await sb.exec("sleep 30")
        await asyncio.sleep(0.2)
        await ex.cancel()
        assert ex.status() == ExecutionStatus.CANCELLED
        # A late natural completion must never overwrite the terminal cancel.
        await asyncio.sleep(1.5)
        assert ex.status() == ExecutionStatus.CANCELLED
        assert ex.result() is not None
    finally:
        await sb.destroy()


async def test_cancel_is_idempotent_and_wait_repeatable():
    sb = await _new_sandbox()
    try:
        ex = await sb.exec("sleep 30")
        await asyncio.sleep(0.15)
        await ex.cancel()
        await ex.cancel()
        await ex.wait()
        await ex.wait()
        assert ex.status() == ExecutionStatus.CANCELLED
    finally:
        await sb.destroy()


async def test_callback_ordering_matches_production_order():
    sb = await _new_sandbox()
    try:
        # node loop, not shell syntax: cmd.exe cannot parse POSIX for-loops,
        # and an empty output would make this test pass vacuously.
        await sb.write_file(
            "lines.js",
            b"for (let i = 1; i <= 5; i++) console.log('line-' + i);",
        )
        ex = await sb.exec("node lines.js")
        chunks: list[str] = []
        ex.on_stdout(chunks.append)
        await ex.wait()
        # Guard against vacuous passes: the workload must have produced
        # output, otherwise ordering proves nothing (POSIX shell syntax
        # fails silently on cmd.exe, which is how this guard was earned).
        assert "line-3" in ex.stdout(), f"workload produced no output: {ex.stdout()!r}"
        # Concatenated callbacks must equal retained stdout: no reordering,
        # no dropped chunks.
        assert "".join(chunks) == ex.stdout()
    finally:
        await sb.destroy()


async def test_async_iterator_observes_same_stream():
    sb = await _new_sandbox()
    try:
        await sb.write_file(
            "rows.js",
            b"for (let i = 1; i <= 3; i++) console.log('row-' + i);",
        )
        ex = await sb.exec("node rows.js")
        await ex.wait()
        # Snapshot semantics like the reference stdoutStream(): iterate
        # retained chunks after the terminal state.
        seen: list[str] = []
        async for chunk in ex.stdout_stream():
            seen.append(chunk)
        assert "".join(seen) == ex.stdout()
        assert "row-2" in "".join(seen)
    finally:
        await sb.destroy()


async def test_concurrent_readers_are_safe():
    sb = await _new_sandbox()
    try:
        await sb.write_file(
            "many.js",
            b"for (let i = 1; i <= 200; i++) console.log('x' + i);",
        )
        ex = await sb.exec("node many.js")

        async def reader() -> None:
            for _ in range(50):
                ex.stdout()
                ex.stderr()
                ex.truncated()
                ex.status()

        await asyncio.gather(*[reader() for _ in range(8)])
        await ex.wait()
        assert "x200" in ex.stdout(), "workload produced no output"
    finally:
        await sb.destroy()


async def test_absent_measurements_stay_none():
    # The F3 scope samples no CPU time: None must survive end to end,
    # never collapsing into a default zero.
    sb = await _new_sandbox()
    try:
        ex = await sb.exec("echo hi")
        await ex.wait()
        assert ex.metadata() is not None
        assert ex.metadata().cpu_time_ms is None
        assert ex.result() is not None
        assert ex.result().cpu_time_ms is None
        assert ex.result().peak_memory_bytes is None
    finally:
        await sb.destroy()


async def test_truncated_emitted_deterministically():
    sb = await _new_sandbox()
    try:
        ex = await sb.exec("echo hi")
        await ex.wait()
        assert ex.result() is not None
        assert ex.result().truncated is False
        assert ex.metadata() is not None
        assert ex.metadata().truncated is False
    finally:
        await sb.destroy()


async def test_bounded_retention_keeps_tail_and_flags_truncation():
    sb = await _new_sandbox()
    try:
        await sb.write_file(
            "flood.js",
            b"const b=Buffer.alloc(65536,120);const{once}=require('events');"
            b"(async()=>{while(true){if(!process.stdout.write(b))await once(process.stdout,'drain');}})();",
        )
        ex = await sb.exec("node flood.js", ExecOptions(timeout=5000))
        await ex.wait()
        assert ex.truncated() is True
        retained = ex.stdout().encode("utf-8")
        assert len(retained) <= 16 * 1024 * 1024 + 1024
        assert ex.stdout().startswith("[output truncated: showing last ")
        assert "x" in ex.stdout()
    finally:
        await sb.destroy()


async def test_error_codes_are_stable_strings():
    sb = await _new_sandbox()
    try:
        with pytest.raises(SandboxError) as exc:
            await sb.read_file("nope/missing.txt")
        assert exc.value.code == "FS_ERROR"
        assert "FS_ERROR" in str(exc.value)
    finally:
        await sb.destroy()
