package sandbox

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"
)

func nowISO() string {
	return time.Now().UTC().Format("2006-01-02T15:04:05.000Z")
}

func newExecID() string {
	var b [4]byte
	_, _ = rand.Read(b[:])
	return "exec_" + hex.EncodeToString(b[:])
}

func boolPtr(v bool) *bool { return &v }

// nativeBackend implements the local OS execution contract with plain Go
// glue: spawn through the platform shell, drain both pipes concurrently,
// enforce wall-clock timeout, kill process trees, and contain all
// filesystem operations to the sandbox root.
type nativeBackend struct {
	dir     string
	realDir string
	opts    SandboxOptions
	caps    Capabilities
	liveMu  sync.Mutex
	live    map[int]struct{}
}

func newNativeBackend(opts SandboxOptions) (*nativeBackend, error) {
	// Pattern (not a base directory): os.MkdirTemp requires the parent to
	// exist, and os.TempDir() is guaranteed to. The process id keeps
	// parallel sandboxes in one host from colliding, and the random suffix
	// keeps concurrent creates distinct.
	dir, err := os.MkdirTemp(os.TempDir(), "palmshed-sandbox-"+fmt.Sprint(os.Getpid())+"-")
	if err != nil {
		return nil, newError(CodeExecFailed, err.Error())
	}
	real, err := filepath.EvalSymlinks(dir)
	if err != nil {
		real = dir
	}
	return &nativeBackend{
		dir:     dir,
		realDir: real,
		opts:    opts,
		caps: Capabilities{
			Filesystem: true,
			// Enforcement and isolation mechanisms are absent at the F2
			// milestone: reported false/unknown, never implied by the API.
			NetworkIsolation:      false,
			CPULimits:             false,
			MemoryLimits:          false,
			Streaming:             true,
			OSFilesystemIsolation: OsFsUnknown,
			RemoteExecution:       false,
			CPUQuotaLimits:        false,
		},
		live: map[int]struct{}{},
	}, nil
}

// isAbsoluteHostPath reports whether p looks like a host-absolute path on
// any supported platform. Go's filepath.IsAbs is platform-selective (a
// leading slash is not absolute on Windows), so the contract check is
// spelled out: POSIX roots, Windows drive letters, UNC shares, and
// backslash roots are all host paths and must be rejected, never silently
// contained. This matches the reference resolveSandboxPath semantics.
func isAbsoluteHostPath(p string) bool {
	if strings.HasPrefix(p, "/") || strings.HasPrefix(p, "\\") {
		return true
	}
	if len(p) >= 3 && p[1] == ':' && (p[2] == '/' || p[2] == '\\') {
		return true
	}
	if len(p) >= 2 && ((p[0] >= 'a' && p[0] <= 'z') || (p[0] >= 'A' && p[0] <= 'Z')) && p[1] == ':' {
		return true
	}
	if strings.HasPrefix(p, `\\`) {
		return true
	}
	return false
}

// resolve contains a sandbox-relative path, rejecting absolute host paths
// and parent traversal before any IO happens.
func (b *nativeBackend) resolve(p string) (string, error) {
	if isAbsoluteHostPath(p) {
		return "", newError(CodeFSError, "absolute host path rejected: "+p)
	}
	clean := filepath.Clean("/" + p)
	full := filepath.Join(b.realDir, clean)
	if full != b.realDir && !strings.HasPrefix(full, b.realDir+string(os.PathSeparator)) {
		return "", newError(CodeFSError, "path escapes sandbox root: "+p)
	}
	return full, nil
}

func (b *nativeBackend) ReadFile(p string) ([]byte, error) {
	full, err := b.resolve(p)
	if err != nil {
		return nil, err
	}
	// Reject symlink escapes: the canonical path must stay under the root.
	canon, err := filepath.EvalSymlinks(full)
	if err != nil {
		return nil, newError(CodeFSError, err.Error())
	}
	if canon != b.realDir && !strings.HasPrefix(canon, b.realDir+string(os.PathSeparator)) {
		return nil, newError(CodeFSError, "symlink escape rejected: "+p)
	}
	data, err := retryIO(func() ([]byte, error) { return os.ReadFile(canon) })
	if err != nil {
		return nil, newError(CodeFSError, err.Error())
	}
	return data, nil
}

func (b *nativeBackend) WriteFile(p string, data []byte) error {
	full, err := b.resolve(p)
	if err != nil {
		return err
	}
	if dir := filepath.Dir(full); dir != b.realDir {
		if err := retryErr(func() error { return os.MkdirAll(dir, 0o755) }); err != nil {
			return newError(CodeFSError, err.Error())
		}
	}
	if err := retryErr(func() error { return os.WriteFile(full, data, 0o644) }); err != nil {
		return newError(CodeFSError, err.Error())
	}
	return nil
}

func (b *nativeBackend) UploadFile(local, remote string) error {
	data, err := os.ReadFile(local)
	if err != nil {
		return newError(CodeFSError, err.Error())
	}
	return b.WriteFile(remote, data)
}

func (b *nativeBackend) DownloadFile(remote, local string) error {
	data, err := b.ReadFile(remote)
	if err != nil {
		return err
	}
	if err := retryErr(func() error { return os.WriteFile(local, data, 0o644) }); err != nil {
		return newError(CodeFSError, err.Error())
	}
	return nil
}

// Exec runs a command and returns a live handle. Output is drained by one
// goroutine per stream; the process is waited on only after both drains
// finish, which is what prevents a pipe-buffer deadlock.
func (b *nativeBackend) Exec(ctx context.Context, command string, opts ExecOptions) (*Execution, error) {
	id := newExecID()
	ex := newExecution(id)
	ex.startedAt = nowISO()

	cwd := b.realDir
	if opts.WorkDir != nil {
		full, err := b.resolve(*opts.WorkDir)
		if err != nil {
			return nil, err
		}
		if err := retryErr(func() error { return os.MkdirAll(full, 0o755) }); err != nil {
			return nil, newError(CodeFSError, err.Error())
		}
		cwd = full
	}

	var cmd *exec.Cmd
	if runtime.GOOS == "windows" {
		cmd = exec.Command("cmd.exe", "/s", "/c", command)
	} else {
		cmd = exec.Command("/bin/sh", "-c", command)
	}
	cmd.Dir = cwd

	// Minimal environment: the host is never inherited wholesale. The
	// Windows key set mirrors the reference contract because the runtime
	// cannot load at all without SystemRoot/ComSpec/UserProfile.
	cmd.Env = buildEnv(b.opts.Env, opts.Env)
	if opts.Stdin != nil {
		cmd.Stdin = opts.Stdin
	}
	stdoutPipe, err := cmd.StdoutPipe()
	if err != nil {
		return nil, newError(CodeExecFailed, err.Error())
	}
	stderrPipe, err := cmd.StderrPipe()
	if err != nil {
		return nil, newError(CodeExecFailed, err.Error())
	}
	if opts.Stdout != nil {
		cmd.Stdout = opts.Stdout
	}
	if opts.Stderr != nil {
		cmd.Stderr = opts.Stderr
	}
	if opts.OnStdout != nil {
		ex.OnStdout(opts.OnStdout)
	}
	if opts.OnStderr != nil {
		ex.OnStderr(opts.OnStderr)
	}

	// Own process group so the whole tree can be signalled at once.
	setProcessGroup(cmd)

	if err := cmd.Start(); err != nil {
		return nil, newError(CodeExecFailed, err.Error())
	}
	pid := cmd.Process.Pid
	b.track(pid)
	ex.registerKill(func() {
		killTree(pid)
		b.untrack(pid)
	})

	timeoutMs := uint64(0)
	if opts.Timeout != nil {
		timeoutMs = *opts.Timeout
	} else if b.opts.Timeout != nil {
		timeoutMs = *b.opts.Timeout
	}

	go b.supervise(ctx, ex, cmd, stdoutPipe, stderrPipe, pid, timeoutMs)
	return ex, nil
}

// supervise drains both streams, waits for the process, applies the
// timeout, and settles exactly one terminal state.
func (b *nativeBackend) supervise(
	ctx context.Context,
	ex *Execution,
	cmd *exec.Cmd,
	stdoutPipe, stderrPipe io.ReadCloser,
	pid int,
	timeoutMs uint64,
) {
	start := time.Now()

	var wg sync.WaitGroup
	var outBuf, errBuf strings.Builder
	wg.Add(2)
	go func() {
		defer wg.Done()
		streamCopy(&outBuf, ex, stdoutPipe, true)
	}()
	go func() {
		defer wg.Done()
		streamCopy(&errBuf, ex, stderrPipe, false)
	}()

	waitCh := make(chan error, 1)
	go func() {
		wg.Wait()
		waitCh <- cmd.Wait()
	}()

	timedOut := false
	if timeoutMs > 0 {
		timer := time.NewTimer(time.Duration(timeoutMs) * time.Millisecond)
		defer timer.Stop()
		select {
		case <-waitCh:
		case <-timer.C:
			timedOut = true
			killTree(pid)
			b.untrack(pid)
			<-waitCh
		}
	} else {
		<-waitCh
	}

	// Caller context cancellation feeds the same guarded terminal state as
	// an explicit Cancel: it never bypasses the state machine.
	if ctx != nil && ctx.Err() != nil {
		ex.Cancel()
	}

	// A non-zero exit is reported through Wait's error, so the exit code
	// comes from the process state. Timeout reports -1 regardless of how
	// the process died, matching the reference contract.
	exitCode := -1
	if !timedOut && cmd.ProcessState != nil {
		exitCode = exitCodeFromState(cmd.ProcessState)
	}

	durationMs := uint64(time.Since(start).Milliseconds())
	res := &ExecResult{
		ID:         ex.id,
		ExitCode:   exitCode,
		Stdout:     outBuf.String(),
		Stderr:     errBuf.String(),
		DurationMs: durationMs,
		TimedOut:   timedOut,
		Truncated:  boolPtr(ex.Truncated()),
		Metadata: ExecutionMetadata{
			ID:          ex.id,
			Backend:     "native",
			SpecVersion: SPEC_VERSION,
			StartedAt:   ex.startedAt,
			FinishedAt:  nowISO(),
			DurationMs:  durationMs,
			ExitCode:    exitCode,
			TimedOut:    timedOut,
			Truncated:   boolPtr(ex.Truncated()),
		},
	}

	status := StatusFailed
	if timedOut {
		status = StatusTimedOut
	} else if exitCode == 0 {
		status = StatusCompleted
	}
	ex.settle(status, res)
}

// streamCopy reads one stream to completion, appending to the retained
// buffer and invoking callbacks in production order.
func streamCopy(buf *strings.Builder, ex *Execution, r io.ReadCloser, isStdout bool) {
	defer r.Close()
	chunk := make([]byte, 8192)
	for {
		n, err := r.Read(chunk)
		if n > 0 {
			str := string(chunk[:n])
			buf.WriteString(str)
			if isStdout {
				ex.pushStdout(str)
			} else {
				ex.pushStderr(str)
			}
		}
		if err != nil {
			return
		}
	}
}

func (b *nativeBackend) track(pid int) {
	b.liveMu.Lock()
	b.live[pid] = struct{}{}
	b.liveMu.Unlock()
}

func (b *nativeBackend) untrack(pid int) {
	b.liveMu.Lock()
	delete(b.live, pid)
	b.liveMu.Unlock()
}

func (b *nativeBackend) Destroy() error {
	b.liveMu.Lock()
	pids := make([]int, 0, len(b.live))
	for pid := range b.live {
		pids = append(pids, pid)
	}
	b.live = map[int]struct{}{}
	b.liveMu.Unlock()

	for _, pid := range pids {
		killTree(pid)
	}
	// Retry: a just-killed tree can still hold handles on Windows.
	err := retryErr(func() error { return os.RemoveAll(b.dir) })
	if err != nil && !os.IsNotExist(err) {
		return newError(CodeExecFailed, err.Error())
	}
	return nil
}
