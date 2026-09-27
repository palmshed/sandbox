//! Public contract types for the Palmshed Sandbox Rust SDK (F1).
//!
//! These map field-for-field to the JSON schemas in `spec/` and to the
//! TypeScript `core/types.ts` surface (see `rfcs/0008-rust-sdk-bindings.md`).
//! No Rust-only semantic extensions.

/// Runtime specification version reported in execution metadata.
/// Keep in sync with `spec/version.md`.
pub const SPEC_VERSION: &str = "1.3.0";

/// Network access policy for a sandbox or execution.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NetworkPolicy {
    Disabled,
    Allow,
    Proxy,
}

/// OS-filesystem isolation status (RFC 0006 tri-state).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OsFilesystemIsolationStatus {
    Supported,
    Unsupported,
    Unknown,
}

/// Execution lifecycle status.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExecutionStatus {
    Running,
    Completed,
    Failed,
    Cancelled,
    TimedOut,
}

/// Backend capability report. Probed at init, never assumed.
#[derive(Debug, Clone)]
pub struct BackendCapabilities {
    pub filesystem: bool,
    pub network_isolation: bool,
    pub cpu_limits: bool,
    pub memory_limits: bool,
    pub streaming: bool,
    pub os_filesystem_isolation: OsFilesystemIsolationStatus,
    pub remote_execution: bool,
    pub cpu_quota_limits: bool,
}

/// Resource limit set, mirroring `ResourceLimits`.
#[derive(Debug, Clone, Default)]
pub struct ResourceLimits {
    pub cpu: Option<f64>,
    pub cpu_quota: Option<f64>,
    pub cpu_time_limit: Option<u64>,
    pub memory: Option<String>,
    pub timeout: Option<u64>,
}

/// Sandbox creation options. Every field is optional; unset means default.
#[derive(Debug, Clone, Default)]
pub struct SandboxOptions {
    pub backend: Option<String>,
    pub cpu: Option<f64>,
    pub cpu_quota: Option<f64>,
    pub cpu_time_limit: Option<u64>,
    pub memory: Option<String>,
    pub disk_quota: Option<String>,
    pub timeout: Option<u64>,
    pub network: Option<NetworkPolicy>,
    pub work_dir: Option<String>,
    pub os_filesystem_isolation: Option<bool>,
    pub env: Vec<(String, String)>,
    pub image: Option<String>,
}

/// Per-execution options. Override sandbox-level settings for one run.
#[derive(Debug, Clone, Default)]
pub struct ExecOptions {
    pub timeout: Option<u64>,
    pub cpu_time_limit: Option<u64>,
    pub cpu_quota: Option<f64>,
    pub memory: Option<String>,
    pub work_dir: Option<String>,
    pub env: Vec<(String, String)>,
}

/// Structured execution metadata, mirroring `ExecutionMetadata`.
#[derive(Debug, Clone)]
pub struct ExecutionMetadata {
    pub id: String,
    pub backend: String,
    pub spec_version: String,
    pub started_at: String,
    pub finished_at: String,
    pub duration_ms: u64,
    pub exit_code: i32,
    pub timed_out: bool,
    /// Sticky retention-loss flag (issue #12). `None` means unknown, never false.
    pub truncated: Option<bool>,
    /// Best-effort CPU time in ms. `None` when unmeasurable.
    pub cpu_time_ms: Option<f64>,
    /// Best-effort lower bound on peak memory in bytes. `None` when unmeasurable.
    pub peak_memory_bytes: Option<u64>,
}

/// Full execution result payload, mirroring `ExecResult`.
#[derive(Debug, Clone)]
pub struct ExecResult {
    pub id: String,
    pub exit_code: i32,
    pub stdout: String,
    pub stderr: String,
    pub duration_ms: u64,
    pub timed_out: bool,
    /// Sticky retention-loss flag. `None` means unknown, never false.
    pub truncated: Option<bool>,
    pub cpu_time_ms: Option<f64>,
    pub peak_memory_bytes: Option<u64>,
    pub metadata: ExecutionMetadata,
}
