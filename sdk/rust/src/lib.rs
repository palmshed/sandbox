//! Palmshed Sandbox Rust SDK (F1).
//!
//! Implements the sandbox contract from `spec/` with its own OS glue and
//! no Node runtime dependency. Binding rules live in
//! `rfcs/0008-rust-sdk-bindings.md`.

pub mod backend;
pub mod error;
pub mod execution;
pub mod sandbox;
pub mod types;

pub use error::{Resource, ResourceError, SandboxError};
pub use execution::Execution;
pub use sandbox::Sandbox;
pub use types::{
    BackendCapabilities, ExecOptions, ExecResult, ExecutionMetadata, ExecutionStatus, NetworkPolicy,
    OsFilesystemIsolationStatus, ResourceLimits, SandboxOptions, SPEC_VERSION,
};
