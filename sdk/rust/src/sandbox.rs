//! Sandbox facade mirroring TypeScript `Sandbox`.
//!
//! Owns one backend instance and forwards the contract surface: create,
//! capabilities, exec, filesystem operations, destroy. Only the native
//! backend exists in F1; other names fail honestly with INVALID_BACKEND.

use crate::backend::native::NativeBackend;
use crate::error::SandboxError;
use crate::execution::Execution;
use crate::types::{BackendCapabilities, ExecOptions, SandboxOptions};

#[derive(Debug)]
pub struct Sandbox {
    backend: NativeBackend,
}

impl Sandbox {
    /// Create a sandbox (native backend only in F1).
    pub async fn create(options: SandboxOptions) -> Result<Self, SandboxError> {
        match options.backend.as_deref().unwrap_or("native") {
            "native" | "" => {
                let backend = NativeBackend::init(options).await?;
                Ok(Self { backend })
            }
            other => Err(SandboxError::new(
                format!("backend '{other}' is not available in this SDK build"),
                "INVALID_BACKEND",
            )),
        }
    }

    /// Backend capability report (probed at init, never assumed).
    pub fn capabilities(&self) -> BackendCapabilities {
        self.backend.capabilities()
    }

    /// Execute a command, returning a live [`Execution`] handle.
    pub async fn exec(&self, command: &str, options: ExecOptions) -> Result<Execution, SandboxError> {
        self.backend.exec(command, options).await
    }

    /// Execute with default options.
    pub async fn exec_simple(&self, command: &str) -> Result<Execution, SandboxError> {
        self.exec(command, ExecOptions::default()).await
    }

    pub async fn read_file(&self, sandbox_path: &str) -> Result<Vec<u8>, SandboxError> {
        self.backend.read_file(sandbox_path).await
    }

    pub async fn write_file(&self, sandbox_path: &str, content: &[u8]) -> Result<(), SandboxError> {
        self.backend.write_file(sandbox_path, content).await
    }

    pub async fn upload_file(&self, local_path: &str, sandbox_path: &str) -> Result<(), SandboxError> {
        self.backend.upload_file(local_path, sandbox_path).await
    }

    pub async fn download_file(&self, sandbox_path: &str, local_path: &str) -> Result<(), SandboxError> {
        self.backend.download_file(sandbox_path, local_path).await
    }

    /// Destroy the sandbox: kill live trees, remove the workspace.
    pub async fn destroy(&self) -> Result<(), SandboxError> {
        self.backend.destroy().await
    }
}
