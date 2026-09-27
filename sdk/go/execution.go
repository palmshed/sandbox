package sandbox

import (
	"fmt"
	"strings"
	"sync"
)

// MaxRetainedBytesPerStream bounds retained output per stream, matching
// the reference contract. Retention drops whole leading chunks (never
// slicing inside a chunk, so multi-byte characters stay intact).
const MaxRetainedBytesPerStream = 16 * 1024 * 1024

// retained is a bounded output buffer. All access is guarded by the
// execution mutex: drain goroutines write while the caller reads.
type retained struct {
	chunks       []string
	retainedSize int
	totalSize    int
	dropped      bool
}

func (r *retained) push(chunk string) {
	if chunk == "" {
		return
	}
	size := len(chunk)
	r.totalSize += size
	r.chunks = append(r.chunks, chunk)
	r.retainedSize += size
	for len(r.chunks) > 1 && r.retainedSize > MaxRetainedBytesPerStream {
		r.retainedSize -= len(r.chunks[0])
		r.chunks = r.chunks[1:]
		r.dropped = true
	}
	if len(r.chunks) == 1 && r.retainedSize > MaxRetainedBytesPerStream {
		// A single over-cap chunk is dropped whole rather than sliced inside
		// a multi-byte character. Its bytes still count toward the total.
		r.retainedSize = 0
		r.chunks = nil
		r.dropped = true
	}
}

func (r *retained) text() string {
	body := strings.Join(r.chunks, "")
	if !r.dropped {
		return body
	}
	return fmt.Sprintf("[output truncated: showing last %d of %d bytes]\n%s", r.retainedSize, r.totalSize, body)
}

// Execution is a live handle to one running execution. It is safe for
// concurrent use: drain goroutines write output while the caller reads
// status, retained output, and results.
type Execution struct {
	id        string
	startedAt string

	mu          sync.Mutex
	status      Status
	result      *ExecResult
	stdout      retained
	stderr      retained
	stdoutCbs   []func(string)
	stderrCbs   []func(string)
	kill        func()
	terminalSet bool

	done chan struct{}
}

func newExecution(id string) *Execution {
	return &Execution{id: id, status: StatusRunning, done: make(chan struct{})}
}

// ID returns the unique execution identifier.
func (e *Execution) ID() string { return e.id }

// URI returns the stable cross-service URI sandbox://execution/<id>.
func (e *Execution) URI() string { return "sandbox://execution/" + e.id }

// Status returns the current lifecycle state.
func (e *Execution) Status() Status {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.status
}

// ExitCode returns the process exit code, or -1 while still running.
func (e *Execution) ExitCode() int {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.result == nil {
		return -1
	}
	return e.result.ExitCode
}

// TimedOut reports whether the execution was terminated by timeout.
func (e *Execution) TimedOut() bool {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.result == nil {
		return false
	}
	return e.result.TimedOut
}

// Truncated reports whether retained output dropped bytes on either
// stream (sticky).
func (e *Execution) Truncated() bool {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.stdout.dropped || e.stderr.dropped
}

// Stdout returns retained stdout (bounded).
func (e *Execution) Stdout() string {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.stdout.text()
}

// Stderr returns retained stderr (bounded).
func (e *Execution) Stderr() string {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.stderr.text()
}

// Logs returns retained stdout plus retained stderr.
func (e *Execution) Logs() string {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.stdout.text() + e.stderr.text()
}

// Metadata returns the structured metadata once settled, else nil.
func (e *Execution) Metadata() *ExecutionMetadata {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.result == nil {
		return nil
	}
	m := e.result.Metadata
	return &m
}

// Result returns the full result once settled, else nil.
func (e *Execution) Result() *ExecResult {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.result == nil {
		return nil
	}
	r := *e.result
	return &r
}

// OnStdout registers a real-time stdout callback. Callbacks run on that
// stream's drain goroutine: a blocking callback blocks only its own
// stream, and callbacks for different streams may run concurrently, so
// they must be safe for concurrent use.
func (e *Execution) OnStdout(cb func(string)) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.stdoutCbs = append(e.stdoutCbs, cb)
}

// OnStderr registers a real-time stderr callback (see OnStdout).
func (e *Execution) OnStderr(cb func(string)) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.stderrCbs = append(e.stderrCbs, cb)
}

// Done returns a channel closed when the execution reaches a terminal
// state. Closing is idempotent, so repeated observation is safe.
func (e *Execution) Done() <-chan struct{} { return e.done }

// Wait blocks until the execution is terminal. Repeated calls return
// immediately once settled.
func (e *Execution) Wait() { <-e.done }

// Cancel terminates the execution: SIGTERM to the process tree, then
// SIGKILL after 1s. The cancelled state is terminal; a later natural
// completion never overwrites it. Cancel is idempotent.
func (e *Execution) Cancel() {
	e.mu.Lock()
	if e.terminalSet {
		e.mu.Unlock()
		return
	}
	e.terminalSet = true
	e.status = StatusCancelled
	kill := e.kill
	e.mu.Unlock()

	if kill != nil {
		kill()
	}
	e.finish()
}

// settle records a natural completion. The first terminal transition
// observed by the guard wins: a cancel that already settled the
// execution is never overwritten.
func (e *Execution) settle(status Status, result *ExecResult) {
	e.mu.Lock()
	if e.terminalSet {
		e.mu.Unlock()
		return
	}
	e.terminalSet = true
	e.status = status
	e.result = result
	e.mu.Unlock()
	e.finish()
}

// finish records a cancel-driven terminal state that has no result yet.
// registerKill installs the tree-termination function once the child has
// spawned. Called by the backend; never public API.
func (e *Execution) registerKill(fn func()) {
	e.mu.Lock()
	e.kill = fn
	e.mu.Unlock()
}

// pushStdout appends a stdout chunk to retained output and fires stdout
// callbacks in production order. Called by the stream's drain goroutine.
func (e *Execution) pushStdout(chunk string) {
	e.mu.Lock()
	e.stdout.push(chunk)
	cbs := make([]func(string), len(e.stdoutCbs))
	copy(cbs, e.stdoutCbs)
	e.mu.Unlock()
	// Callbacks run outside the lock so a blocking callback cannot stall the
	// guard, and so callers may re-enter the handle safely.
	for _, cb := range cbs {
		cb(chunk)
	}
}

// pushStderr is the stderr counterpart of pushStdout.
func (e *Execution) pushStderr(chunk string) {
	e.mu.Lock()
	e.stderr.push(chunk)
	cbs := make([]func(string), len(e.stderrCbs))
	copy(cbs, e.stderrCbs)
	e.mu.Unlock()
	for _, cb := range cbs {
		cb(chunk)
	}
}

func (e *Execution) finish() {
	e.mu.Lock()
	if e.result == nil {
		// A cancelled execution still records what was captured so far so
		// Result is not nil after a terminal transition.
		e.result = &ExecResult{
			ID:        e.id,
			ExitCode:  -1,
			Truncated: b(e.stdout.dropped || e.stderr.dropped),
			Metadata: ExecutionMetadata{
				ID:          e.id,
				Backend:     "native",
				SpecVersion: SPEC_VERSION,
				StartedAt:   e.startedAt,
				FinishedAt:  nowISO(),
				ExitCode:    -1,
				Truncated:   b(e.stdout.dropped || e.stderr.dropped),
			},
		}
	}
	e.mu.Unlock()
	close(e.done)
}
