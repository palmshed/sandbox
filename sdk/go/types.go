// Package sandbox implements the Palmshed Sandbox runtime contract in Go.
//
// The JSON schemas in spec/ are authoritative; this package implements
// them without redefining them. Binding rules live in
// rfcs/0009-go-sdk-bindings.md.
package sandbox

// SPEC_VERSION is the runtime specification version reported in
// execution metadata. Keep in sync with spec/version.md.
const SPEC_VERSION = "1.3.0"

// NetworkPolicy is the network access policy for a sandbox.
type NetworkPolicy string

const (
	NetworkDisabled NetworkPolicy = "disabled"
	NetworkAllow    NetworkPolicy = "allow"
	NetworkProxy    NetworkPolicy = "proxy"
)

// OsFilesystemIsolation is the RFC 0006 tri-state capability value.
// Unknown is distinct from Unsupported and must never be coerced to a
// boolean.
type OsFilesystemIsolation string

const (
	OsFsSupported   OsFilesystemIsolation = "supported"
	OsFsUnsupported OsFilesystemIsolation = "unsupported"
	OsFsUnknown     OsFilesystemIsolation = "unknown"
)

// Status is the execution lifecycle state.
type Status string

const (
	StatusRunning   Status = "running"
	StatusCompleted Status = "completed"
	StatusFailed    Status = "failed"
	StatusCancelled Status = "cancelled"
	StatusTimedOut  Status = "timedout"
)

// Capabilities is the backend capability report, probed at init. Flags are
// false when a mechanism is absent; they are never true merely because an
// API exists.
type Capabilities struct {
	Filesystem            bool
	NetworkIsolation      bool
	CPULimits             bool
	MemoryLimits          bool
	Streaming             bool
	OSFilesystemIsolation OsFilesystemIsolation
	RemoteExecution       bool
	CPUQuotaLimits        bool
}

// ResourceLimits mirrors the spec resource limit set. Nil means unset.
type ResourceLimits struct {
	CPU          *float64
	CPUQuota     *float64
	CPUTimeLimit *uint64
	Memory       *string
	Timeout      *uint64
}

// SandboxOptions are the sandbox creation options. Nil means default.
type SandboxOptions struct {
	Backend               *string
	CPU                   *float64
	CPUQuota              *float64
	CPUTimeLimit          *uint64
	Memory                *string
	DiskQuota             *string
	Timeout               *uint64
	Network               *NetworkPolicy
	WorkDir               *string
	OSFilesystemIsolation *bool
	Env                   map[string]string
	Image                 *string
}

// ExecOptions are per-execution overrides. Nil means inherit.
type ExecOptions struct {
	Timeout      *uint64
	CPUTimeLimit *uint64
	CPUQuota     *float64
	Memory       *string
	WorkDir      *string
	Env          map[string]string
	Stdin        interface{ Read([]byte) (int, error) }
	Stdout       interface{ Write([]byte) (int, error) }
	Stderr       interface{ Write([]byte) (int, error) }
	OnStdout     func(string)
	OnStderr     func(string)
}

// ExecutionMetadata mirrors the spec ExecutionMetadata object.
type ExecutionMetadata struct {
	ID              string   `json:"id"`
	Backend         string   `json:"backend"`
	SpecVersion     string   `json:"specVersion"`
	StartedAt       string   `json:"startedAt"`
	FinishedAt      string   `json:"finishedAt"`
	DurationMs      uint64   `json:"durationMs"`
	ExitCode        int      `json:"exitCode"`
	TimedOut        bool     `json:"timedOut"`
	Truncated       *bool    `json:"truncated,omitempty"`
	CPUTimeMs       *float64 `json:"cpuTimeMs,omitempty"`
	PeakMemoryBytes *uint64  `json:"peakMemoryBytes,omitempty"`
}

// ExecResult mirrors the spec ExecResult object. Truncated is a pointer so
// absence (unknown) is distinct from false.
type ExecResult struct {
	ID              string            `json:"id"`
	ExitCode        int               `json:"exitCode"`
	Stdout          string            `json:"stdout"`
	Stderr          string            `json:"stderr"`
	DurationMs      uint64            `json:"durationMs"`
	TimedOut        bool              `json:"timedOut"`
	Truncated       *bool             `json:"truncated,omitempty"`
	CPUTimeMs       *float64          `json:"cpuTimeMs,omitempty"`
	PeakMemoryBytes *uint64           `json:"peakMemoryBytes,omitempty"`
	Metadata        ExecutionMetadata `json:"metadata"`
}

func f64(v float64) *float64 { return &v }
func u64(v uint64) *uint64   { return &v }
func s(v string) *string     { return &v }
func b(v bool) *bool         { return &v }
