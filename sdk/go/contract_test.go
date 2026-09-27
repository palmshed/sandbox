package sandbox_test

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	sandbox "github.com/palmshed/sandbox/sdk/go"
)

// ---- Normative contract ports (assertion source: the TypeScript
// compliance suite). Platform-divergent behavior skips with a reason and
// is never weakened to pass. ----

func TestSpecExecutionHandleURIAndInitialStatus(t *testing.T) {
	sb := newSandbox(t)
	ex := execSimple(t, sb, "echo Compliance")
	if !strings.HasPrefix(ex.ID(), "exec_") {
		t.Fatalf("id: %q", ex.ID())
	}
	if !strings.HasPrefix(ex.URI(), "sandbox://execution/exec_") {
		t.Fatalf("uri: %q", ex.URI())
	}
	ex.Wait()
	if ex.Status() != sandbox.StatusCompleted {
		t.Fatalf("status: %s", ex.Status())
	}
}

func TestSpecCommandExecutionAndExitCode(t *testing.T) {
	sb := newSandbox(t)
	ex := execSimple(t, sb, "echo Compliance-Test")
	ex.Wait()
	if ex.ExitCode() != 0 {
		t.Fatalf("exit: %d", ex.ExitCode())
	}
	if ex.TimedOut() {
		t.Fatal("unexpected timeout")
	}
}

func TestSpecExecutionMetadata(t *testing.T) {
	sb := newSandbox(t)
	ex := execSimple(t, sb, "echo Metadata")
	ex.Wait()
	m := ex.Metadata()
	if m == nil {
		t.Fatal("metadata nil after wait")
	}
	if m.Backend != "native" {
		t.Fatalf("backend: %s", m.Backend)
	}
	if m.SpecVersion != sandbox.SPEC_VERSION {
		t.Fatalf("specVersion: %s", m.SpecVersion)
	}
	// ISO-8601 UTC with millis, matching the reference shape.
	for _, ts := range []string{m.StartedAt, m.FinishedAt} {
		if !strings.HasSuffix(ts, "Z") || len(ts) != 24 {
			t.Fatalf("timestamp shape: %q", ts)
		}
		if _, err := time.Parse("2006-01-02T15:04:05.000Z", ts); err != nil {
			t.Fatalf("timestamp parse: %q (%v)", ts, err)
		}
	}
}

func TestSpecRealtimeStdoutStreaming(t *testing.T) {
	sb := newSandbox(t)
	ex := execSimple(t, sb, "echo Stream-Chunk")
	var mu sync.Mutex
	var seen strings.Builder
	ex.OnStdout(func(c string) {
		mu.Lock()
		defer mu.Unlock()
		seen.WriteString(c)
	})
	ex.Wait()
	mu.Lock()
	defer mu.Unlock()
	if !strings.Contains(seen.String(), "Stream-Chunk") {
		t.Fatalf("callbacks missed payload: %q", seen.String())
	}
}

func TestSpecTimeoutEnforcementAndTimedOutStatus(t *testing.T) {
	sb := newSandbox(t)
	timeout := uint64(400)
	ex, err := sb.Exec(context.Background(), "sleep 30", sandbox.ExecOptions{Timeout: &timeout})
	if err != nil {
		t.Fatal(err)
	}
	ex.Wait()
	if ex.Status() != sandbox.StatusTimedOut {
		t.Fatalf("status: %s", ex.Status())
	}
	if ex.ExitCode() != -1 {
		t.Fatalf("exit: %d", ex.ExitCode())
	}
	if !ex.Metadata().TimedOut {
		t.Fatal("metadata.timedOut false")
	}
}

func TestSpecFailingCommandReportsFailed(t *testing.T) {
	sb := newSandbox(t)
	ex := execSimple(t, sb, "exit 3")
	ex.Wait()
	if ex.Status() != sandbox.StatusFailed {
		t.Fatalf("status: %s", ex.Status())
	}
	if ex.ExitCode() != 3 {
		t.Fatalf("exit: %d", ex.ExitCode())
	}
}

func TestSpecCapabilityNegotiationFlags(t *testing.T) {
	sb := newSandbox(t)
	c := sb.Capabilities()
	if !c.Filesystem || !c.Streaming {
		t.Fatalf("caps: %+v", c)
	}
	if c.RemoteExecution {
		t.Fatal("remoteExecution must be false")
	}
	switch c.OSFilesystemIsolation {
	case sandbox.OsFsSupported, sandbox.OsFsUnsupported, sandbox.OsFsUnknown:
	default:
		t.Fatalf("osFilesystemIsolation not a documented tri-state: %q", c.OSFilesystemIsolation)
	}
	// Enforcement capabilities are absent at this milestone and must be
	// reported false, never true because the option exists.
	if c.CPULimits || c.MemoryLimits || c.CPUQuotaLimits {
		t.Fatalf("unenforced capabilities must be false: %+v", c)
	}
}

func TestSpecVFSIsolationBoundary(t *testing.T) {
	sb := newSandbox(t)
	if _, err := sb.ReadFile("../../../../etc/hosts"); err == nil || codeOf(err) != sandbox.CodeFSError {
		t.Fatalf("traversal: %v", err)
	}
	if err := sb.WriteFile("/etc/evil.txt", []byte("x")); err == nil || codeOf(err) != sandbox.CodeFSError {
		t.Fatalf("absolute: %v", err)
	}
	if runtimeIsWindows() {
		t.Skip("symlink escape assertion is POSIX-only")
	}
	if err := sb.WriteFile("plant.js", []byte("require('fs').symlinkSync('/etc/hosts','link.txt')")); err != nil {
		t.Fatal(err)
	}
	plant := execSimple(t, sb, "node plant.js")
	plant.Wait()
	if _, err := sb.ReadFile("link.txt"); err == nil || codeOf(err) != sandbox.CodeFSError {
		t.Fatalf("symlink escape: %v", err)
	}
}

func TestSpecEnvironmentContract(t *testing.T) {
	t.Setenv("HOST_LEAK_VAR", "should-not-leak")
	explicit := "injected"
	sb2, err := sandbox.Create(context.Background(), sandbox.SandboxOptions{
		Env: map[string]string{"EXPLICIT_VAR": explicit},
	})
	if err != nil {
		t.Fatal(err)
	}
	defer sb2.Destroy()
	script := "console.log((process.env.HOST_LEAK_VAR||'absent') + ' ' + (process.env.EXPLICIT_VAR||'absent') + ' ' + (process.env.PATH?'path':'nopath'))"
	if err := sb2.WriteFile("env.js", []byte(script)); err != nil {
		t.Fatal(err)
	}
	ex := execSimple(t, sb2, "node env.js")
	ex.Wait()
	if ex.ExitCode() != 0 {
		t.Fatalf("exit %d: %s", ex.ExitCode(), ex.Stderr())
	}
	if !strings.Contains(ex.Stdout(), "absent injected path") {
		t.Fatalf("env contract: %q", ex.Stdout())
	}
}

func TestSpecUnknownBackendFailsHonestly(t *testing.T) {
	name := "firecracker"
	_, err := sandbox.Create(context.Background(), sandbox.SandboxOptions{Backend: &name})
	if err == nil || codeOf(err) != sandbox.CodeInvalidBackend {
		t.Fatalf("expected INVALID_BACKEND, got %v", err)
	}
}

// ---- Go-specific contract behavior (RFC 0009 section 2) ----

func TestGuardedTerminalStateCancelIsTerminal(t *testing.T) {
	sb := newSandbox(t)
	ex := execSimple(t, sb, "sleep 30")
	time.Sleep(200 * time.Millisecond)
	ex.Cancel()
	ex.Wait()
	if ex.Status() != sandbox.StatusCancelled {
		t.Fatalf("status: %s", ex.Status())
	}
	// A late natural completion must never overwrite the terminal cancel.
	time.Sleep(1500 * time.Millisecond)
	if ex.Status() != sandbox.StatusCancelled {
		t.Fatalf("terminal state overwritten after settle: %s", ex.Status())
	}
	if ex.Result() == nil {
		t.Fatal("result nil after terminal state")
	}
}

func TestCancelIsIdempotentAndWaitRepeatable(t *testing.T) {
	sb := newSandbox(t)
	ex := execSimple(t, sb, "sleep 30")
	time.Sleep(150 * time.Millisecond)
	ex.Cancel()
	ex.Cancel()
	ex.Wait()
	ex.Wait()
	select {
	case <-ex.Done():
	default:
		t.Fatal("Done channel not closed after terminal state")
	}
}

func TestCallbackOrderingMatchesProductionOrder(t *testing.T) {
	sb := newSandbox(t)
	ex := execSimple(t, sb, "for i in 1 2 3 4 5; do echo line-$i; done")
	var mu sync.Mutex
	var chunks []string
	ex.OnStdout(func(c string) {
		mu.Lock()
		defer mu.Unlock()
		chunks = append(chunks, c)
	})
	ex.Wait()
	mu.Lock()
	defer mu.Unlock()
	// Concatenated callbacks must equal retained stdout: no reordering,
	// no dropped chunks.
	var joined strings.Builder
	for _, c := range chunks {
		joined.WriteString(c)
	}
	if joined.String() != ex.Stdout() {
		t.Fatalf("callback order diverged from retained output:\ncb=%q\nout=%q", joined.String(), ex.Stdout())
	}
}

func TestConcurrentReadersAreSafe(t *testing.T) {
	sb := newSandbox(t)
	ex := execSimple(t, sb, "for i in $(seq 1 200); do echo x$i; done")
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := 0; j < 50; j++ {
				_ = ex.Stdout()
				_ = ex.Stderr()
				_ = ex.Truncated()
				_ = ex.Status()
			}
		}()
	}
	wg.Wait()
	ex.Wait()
}

func TestAbsentMeasurementsStayNil(t *testing.T) {
	sb := newSandbox(t)
	ex := execSimple(t, sb, "echo hi")
	ex.Wait()
	res := ex.Result()
	if res.CPUTimeMs != nil {
		t.Fatalf("cpuTimeMs must be nil when unmeasurable, got %v", *res.CPUTimeMs)
	}
	if res.PeakMemoryBytes != nil {
		t.Fatalf("peakMemoryBytes must be nil when unmeasurable, got %v", *res.PeakMemoryBytes)
	}
	if ex.Metadata().CPUTimeMs != nil || ex.Metadata().PeakMemoryBytes != nil {
		t.Fatal("metadata collapsed absent measurements into values")
	}
}

func TestTruncatedEmittedDeterministically(t *testing.T) {
	sb := newSandbox(t)
	ex := execSimple(t, sb, "echo hi")
	ex.Wait()
	res := ex.Result()
	if res.Truncated == nil {
		t.Fatal("truncated must be emitted by the SDK, not absent")
	}
	if *res.Truncated != false {
		t.Fatalf("truncated: %v", *res.Truncated)
	}
	if *ex.Metadata().Truncated != false {
		t.Fatal("metadata truncated mismatch")
	}
}

func TestBoundedRetentionKeepsTailAndFlagsTruncation(t *testing.T) {
	sb := newSandbox(t)
	if err := sb.WriteFile("flood.js", []byte(
		"const b=Buffer.alloc(65536,120);const{once}=require('events');(async()=>{while(true){if(!process.stdout.write(b))await once(process.stdout,'drain');}})();")); err != nil {
		t.Fatal(err)
	}
	timeout := uint64(5000)
	ex, err := sb.Exec(context.Background(), "node flood.js", sandbox.ExecOptions{Timeout: &timeout})
	if err != nil {
		t.Fatal(err)
	}
	ex.Wait()
	if !ex.Truncated() {
		t.Fatal("unbounded producer must set truncated")
	}
	retained := ex.Stdout()
	if len(retained) > sandbox.MaxRetainedBytesPerStream+1024 {
		t.Fatalf("retained %d bytes exceeds cap", len(retained))
	}
	if !strings.HasPrefix(retained, "[output truncated: showing last ") {
		t.Fatalf("missing truncation marker: %q", retained[:60])
	}
	if !strings.Contains(retained, "x") {
		t.Fatal("tail content missing from retained output")
	}
}

func TestFilesystemRoundTrip(t *testing.T) {
	sb := newSandbox(t)
	if err := sb.WriteFile("sub/dir.txt", []byte("data")); err != nil {
		t.Fatal(err)
	}
	got, err := sb.ReadFile("sub/dir.txt")
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "data" {
		t.Fatalf("round trip: %q", got)
	}
	local := filepath.Join(t.TempDir(), "out.txt")
	if err := sb.DownloadFile("sub/dir.txt", local); err != nil {
		t.Fatal(err)
	}
	if b, err := os.ReadFile(local); err != nil || string(b) != "data" {
		t.Fatalf("download: %q %v", b, err)
	}
}

func TestErrorCodesAreStable(t *testing.T) {
	sb := newSandbox(t)
	_, err := sb.ReadFile("nope/missing.txt")
	if err == nil || codeOf(err) != sandbox.CodeFSError {
		t.Fatalf("expected FS_ERROR, got %v", err)
	}
	if !strings.Contains(err.Error(), sandbox.CodeFSError) {
		t.Fatalf("error string must carry the code: %q", err.Error())
	}
}

// ---- helpers ----

func newSandbox(t *testing.T) *sandbox.Sandbox {
	t.Helper()
	sb, err := sandbox.Create(context.Background(), sandbox.SandboxOptions{})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	t.Cleanup(func() { _ = sb.Destroy() })
	return sb
}

func execSimple(t *testing.T, sb *sandbox.Sandbox, cmd string) *sandbox.Execution {
	t.Helper()
	ex, err := sb.ExecSimple(context.Background(), cmd)
	if err != nil {
		t.Fatalf("exec %q: %v", cmd, err)
	}
	return ex
}

func codeOf(err error) string {
	if e, ok := err.(*sandbox.Error); ok {
		return e.Code
	}
	return ""
}

func runtimeIsWindows() bool { return os.PathSeparator == '\\' }
