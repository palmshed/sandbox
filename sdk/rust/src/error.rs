//! Error types mirroring the TypeScript `SandboxError` contract.
//!
//! Codes are stable strings shared across SDKs: `EXEC_FAILED`,
//! `FS_ERROR`, `INVALID_BACKEND`, `ERR_CPU_EXCEEDED`, `ERR_OOM_EXCEEDED`,
//! `ERR_DISK_QUOTA_EXCEEDED`.

use std::fmt;

/// Base sandbox error with a stable machine-readable code.
#[derive(Debug, Clone)]
pub struct SandboxError {
    pub message: String,
    pub code: String,
}

impl SandboxError {
    pub fn new(message: impl Into<String>, code: impl Into<String>) -> Self {
        Self { message: message.into(), code: code.into() }
    }
}

impl fmt::Display for SandboxError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for SandboxError {}

/// Resource class for [`ResourceError`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Resource {
    Cpu,
    Memory,
    Disk,
}

/// Structured resource-exhaustion error (recoverable; the sandbox stays usable).
#[derive(Debug, Clone)]
pub struct ResourceError {
    pub code: String,
    pub resource: Resource,
    pub limit: String,
    pub observed: Option<String>,
    pub recoverable: bool,
}

impl fmt::Display for ResourceError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {:?} limit {} exceeded", self.code, self.resource, self.limit)
    }
}

impl std::error::Error for ResourceError {}
