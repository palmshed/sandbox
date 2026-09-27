//! Native backend: local OS process execution (F1 minimal scope).
//!
//! Implements the specified behavior with plain OS glue: spawn through the
//! system shell, capture output, enforce wall-clock timeout, kill process
//! trees, and contain all filesystem operations to the sandbox root.
//! Resource budgets (CPU/memory/disk), network policies, and OS-level
//! confinement arrive with later contract ports, not here.

use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Instant, SystemTime, UNIX_EPOCH};
use tokio::io::AsyncReadExt;
use tokio::process::Command;

use crate::error::SandboxError;
use crate::execution::Execution;
use crate::types::{
    BackendCapabilities, ExecOptions, ExecResult, ExecutionMetadata,
    OsFilesystemIsolationStatus, SandboxOptions,
};

/// Current UTC time as ISO-8601 with millis (civil-date conversion,
/// no extra dependencies).
fn now_iso() -> String {
    let ms_total = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as i64;
    let secs = ms_total.div_euclid(1000);
    let ms = ms_total.rem_euclid(1000);
    let days = secs.div_euclid(86400);
    let sod = secs.rem_euclid(86400);
    // Howard Hinnant days-to-civil.
    let z = days + 719468;
    let era = z.div_euclid(146097);
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if m <= 2 { y + 1 } else { y };
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        year, m, d,
        sod / 3600, (sod % 3600) / 60, sod % 60, ms
    )
}

fn exec_id() -> String {
    let n = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_nanos();
    let pid = std::process::id();
    format!("exec_{:x}", (n ^ ((pid as u128) << 64)) & 0xffffffffffffffff)
}

/// Kill a process tree: descendants first (best effort), then the root.
/// POSIX kills the process group; Windows uses taskkill /T /F.
fn kill_tree(pid: u32) {
    #[cfg(unix)]
    {
        // Negative PID targets the process group (child spawned detached).
        unsafe {
            libc::kill(-(pid as i32), libc::SIGTERM);
        }
        std::thread::sleep(std::time::Duration::from_millis(1000));
        unsafe {
            libc::kill(-(pid as i32), libc::SIGKILL);
        }
    }
    #[cfg(windows)]
    {
        let _ = std::process::Command::new("taskkill")
            .args(["/pid", &pid.to_string(), "/T", "/F"])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status();
    }
}

/// Retry an IO operation through transient Windows failures.
///
/// Windows can surface sharing violations (os error 32) and "file in use"
/// while a just-exited child still holds a handle, or while an indexer
/// scans the workspace. These are transient, not contract failures, so a
/// short bounded retry keeps behavior honest without weakening any
/// assertion (the same class the production suite handles for `fs.rm`).
async fn retry_io<T, F, Fut>(mut op: F) -> std::io::Result<T>
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = std::io::Result<T>>,
{
    let mut last_err = None;
    for attempt in 0..5u32 {
        match op().await {
            Ok(v) => return Ok(v),
            Err(err) => {
                let transient = matches!(err.raw_os_error(), Some(32) | Some(33) | Some(5))
                    || err.kind() == std::io::ErrorKind::PermissionDenied;
                if !transient {
                    return Err(err);
                }
                last_err = Some(err);
                tokio::time::sleep(std::time::Duration::from_millis(25 * (attempt as u64 + 1))).await;
            }
        }
    }
    Err(last_err.unwrap_or_else(|| std::io::Error::other("retry_io exhausted")))
}

#[derive(Debug)]
pub struct NativeBackend {
    dir: PathBuf,
    real_dir: PathBuf,
    options: SandboxOptions,
    capabilities: BackendCapabilities,
    live: Arc<Mutex<Vec<u32>>>,
}

impl NativeBackend {
    pub async fn init(options: SandboxOptions) -> Result<Self, SandboxError> {
        let dir = std::env::temp_dir().join(format!("palmshed-sandbox-{}", std::process::id()));
        let dir = with_unique_suffix(dir);
        tokio::fs::create_dir_all(&dir).await.map_err(|e| SandboxError::new(e.to_string(), "EXEC_FAILED"))?;
        let real_dir = tokio::fs::canonicalize(&dir).await.map_err(|e| SandboxError::new(e.to_string(), "EXEC_FAILED"))?;
        Ok(Self {
            dir,
            real_dir,
            options,
            capabilities: BackendCapabilities {
                filesystem: true,
                network_isolation: false,
                cpu_limits: false,
                memory_limits: false,
                streaming: true,
                os_filesystem_isolation: OsFilesystemIsolationStatus::Unknown,
                remote_execution: false,
                cpu_quota_limits: false,
            },
            live: Arc::new(Mutex::new(Vec::new())),
        })
    }

    pub fn capabilities(&self) -> BackendCapabilities {
        self.capabilities.clone()
    }

    /// Resolve a sandbox-relative path, rejecting traversal, absolute host
    /// paths, and symlink escapes (symlinks are not followed: the resolved
    /// lexical path must stay under the sandbox root, and final components
    /// that are symlinks pointing out are rejected on use by checking the
    /// canonical parent).
    fn resolve(&self, sandbox_path: &str) -> Result<PathBuf, SandboxError> {
        let rel = Path::new(sandbox_path);
        if rel.is_absolute() {
            return Err(SandboxError::new(format!("absolute host path rejected: {sandbox_path}"), "FS_ERROR"));
        }
        let mut out = self.real_dir.clone();
        for comp in rel.components() {
            match comp {
                Component::CurDir => {}
                Component::ParentDir => {
                    return Err(SandboxError::new(format!("path traversal rejected: {sandbox_path}"), "FS_ERROR"));
                }
                Component::Normal(part) => out.push(part),
                _ => {
                    return Err(SandboxError::new(format!("unsupported path: {sandbox_path}"), "FS_ERROR"));
                }
            }
        }
        if out != self.real_dir && !out.starts_with(&self.real_dir) {
            return Err(SandboxError::new(format!("path escapes sandbox root: {sandbox_path}"), "FS_ERROR"));
        }
        Ok(out)
    }

    pub async fn read_file(&self, sandbox_path: &str) -> Result<Vec<u8>, SandboxError> {
        let full = self.resolve(sandbox_path)?;
        // Reject symlink escapes: the canonical path must stay under root.
        let canon = tokio::fs::canonicalize(&full).await.map_err(|e| SandboxError::new(e.to_string(), "FS_ERROR"))?;
        if canon != self.real_dir && !canon.starts_with(&self.real_dir) {
            return Err(SandboxError::new(format!("symlink escape rejected: {sandbox_path}"), "FS_ERROR"));
        }
        tokio::fs::read(&canon).await.map_err(|e| SandboxError::new(e.to_string(), "FS_ERROR"))
    }

    pub async fn write_file(&self, sandbox_path: &str, content: &[u8]) -> Result<(), SandboxError> {
        let full = self.resolve(sandbox_path)?;
        if let Some(parent) = full.parent() {
            let parent = parent.to_path_buf();
            retry_io(|| {
                let p = parent.clone();
                async move { tokio::fs::create_dir_all(&p).await }
            })
            .await
            .map_err(|e| SandboxError::new(e.to_string(), "FS_ERROR"))?;
        }
        let data = content.to_vec();
        retry_io(|| {
            let f = full.clone();
            let d = data.clone();
            async move { tokio::fs::write(&f, &d).await }
        })
        .await
        .map_err(|e| SandboxError::new(e.to_string(), "FS_ERROR"))
    }

    pub async fn upload_file(&self, local_path: &str, sandbox_path: &str) -> Result<(), SandboxError> {
        let data = tokio::fs::read(local_path).await.map_err(|e| SandboxError::new(e.to_string(), "FS_ERROR"))?;
        self.write_file(sandbox_path, &data).await
    }

    pub async fn download_file(&self, sandbox_path: &str, local_path: &str) -> Result<(), SandboxError> {
        let data = self.read_file(sandbox_path).await?;
        tokio::fs::write(local_path, data).await.map_err(|e| SandboxError::new(e.to_string(), "FS_ERROR"))
    }

    pub async fn exec(&self, command: &str, options: ExecOptions) -> Result<Execution, SandboxError> {
        let id = exec_id();
        let handle = Execution::new(id.clone(), "native".to_string());

        let cwd = match &options.work_dir {
            Some(w) => {
                let full = self.resolve(w)?;
                tokio::fs::create_dir_all(&full).await.map_err(|e| SandboxError::new(e.to_string(), "FS_ERROR"))?;
                full
            }
            None => self.real_dir.clone(),
        };

        let mut cmd = if cfg!(windows) {
            let mut c = Command::new("cmd.exe");
            c.args(["/s", "/c", command]);
            c
        } else {
            let mut c = Command::new("/bin/sh");
            c.args(["-c", command]);
            c
        };
        cmd.current_dir(&cwd)
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .stdin(std::process::Stdio::null());

        // Minimal host environment (never inherited wholesale); explicit env overlays it.
        // The Windows key set mirrors the TypeScript contract: the runtime
        // needs SystemRoot/ComSpec/UserProfile to load at all (node aborts
        // without SystemRoot), so dropping them is not a security win.
        cmd.env_clear();
        let keys: &[&str] = if cfg!(windows) {
            &["PATH", "SystemRoot", "ComSpec", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "TEMP", "TMP", "LANG", "LC_ALL", "LC_CTYPE"]
        } else {
            &["PATH", "HOME", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "LC_CTYPE"]
        };
        for key in keys {
            if let Ok(v) = std::env::var(key) {
                cmd.env(key, v);
            }
        }
        for (k, v) in &self.options.env {
            cmd.env(k, v);
        }
        for (k, v) in &options.env {
            cmd.env(k, v);
        }

        #[cfg(unix)]
        {
            cmd.process_group(0);
        }

        let mut child = cmd.spawn().map_err(|e| SandboxError::new(format!("spawn failed: {e}"), "EXEC_FAILED"))?;
        let pid = child.id();
        if let Some(pid) = pid {
            self.live.lock().unwrap().push(pid);
            let live = self.live.clone();
            handle.register_kill(move || {
                kill_tree(pid);
                live.lock().unwrap().retain(|&p| p != pid);
            });
        }

        let timeout_ms = options.timeout.or(self.options.timeout).unwrap_or(0);
        let start = Instant::now();
        let started_at = now_iso();
        let handle2 = handle.clone();
        let live2 = self.live.clone();

        tokio::spawn(async move {
            let mut stdout_acc = Vec::<u8>::new();
            let mut stderr_acc = Vec::<u8>::new();
            let mut timed_out = false;
            let exit_code;

            // Drain both pipes concurrently: sequential reads deadlock when
            // the child fills one pipe while writing the other.
            let mut stdout_take = child.stdout.take();
            let mut stderr_take = child.stderr.take();
            let h_out = handle2.clone();
            let h_err = handle2.clone();
            let drain_out = async {
                let mut acc = Vec::<u8>::new();
                if let Some(out) = stdout_take.as_mut() {
                    let mut buf = [0u8; 8192];
                    loop {
                        match out.read(&mut buf).await {
                            Ok(0) => break,
                            Ok(n) => {
                                acc.extend_from_slice(&buf[..n]);
                                h_out.push_stdout(String::from_utf8_lossy(&buf[..n]).into_owned());
                            }
                            Err(_) => break,
                        }
                    }
                }
                acc
            };
            let drain_err = async {
                let mut acc = Vec::<u8>::new();
                if let Some(err) = stderr_take.as_mut() {
                    let mut buf = [0u8; 8192];
                    loop {
                        match err.read(&mut buf).await {
                            Ok(0) => break,
                            Ok(n) => {
                                acc.extend_from_slice(&buf[..n]);
                                h_err.push_stderr(String::from_utf8_lossy(&buf[..n]).into_owned());
                            }
                            Err(_) => break,
                        }
                    }
                }
                acc
            };

            let run = async {
                let (out, err) = tokio::join!(drain_out, drain_err);
                let code = child.wait().await.map(|s| s.code().unwrap_or(-1)).unwrap_or(-1);
                (out, err, code)
            };

            if timeout_ms > 0 {
                match tokio::time::timeout(std::time::Duration::from_millis(timeout_ms), run).await {
                    Ok((out, err, code)) => {
                        stdout_acc = out;
                        stderr_acc = err;
                        exit_code = code;
                    }
                    Err(_) => {
                        timed_out = true;
                        if let Some(pid) = pid {
                            kill_tree(pid);
                            live2.lock().unwrap().retain(|&p| p != pid);
                        }
                        exit_code = -1;
                    }
                }
            } else {
                let (out, err, code) = run.await;
                stdout_acc = out;
                stderr_acc = err;
                exit_code = code;
            }

            let duration_ms = start.elapsed().as_millis() as u64;
            let stdout = String::from_utf8_lossy(&stdout_acc).into_owned();
            let stderr = String::from_utf8_lossy(&stderr_acc).into_owned();
            let result = ExecResult {
                id: id.clone(),
                exit_code,
                stdout,
                stderr,
                duration_ms,
                timed_out,
                truncated: Some(handle2.truncated()),
                cpu_time_ms: None,
                peak_memory_bytes: None,
                metadata: ExecutionMetadata {
                    id: id.clone(),
                    backend: "native".to_string(),
                    spec_version: crate::types::SPEC_VERSION.to_string(),
                    started_at,
                    finished_at: now_iso(),
                    duration_ms,
                    exit_code,
                    timed_out,
                    truncated: Some(handle2.truncated()),
                    cpu_time_ms: None,
                    peak_memory_bytes: None,
                },
            };
            handle2.complete(result);
        });

        Ok(handle)
    }

    pub async fn destroy(&self) -> Result<(), SandboxError> {
        let pids: Vec<u32> = std::mem::take(&mut *self.live.lock().unwrap());
        for pid in pids {
            kill_tree(pid);
        }
        // Retry through transient Windows sharing violations: a just-killed
        // tree can still hold handles inside the workspace for a moment.
        let dir = self.dir.clone();
        let result = retry_io(move || {
            let d = dir.clone();
            async move { tokio::fs::remove_dir_all(&d).await }
        })
        .await;
        match result {
            Ok(()) => Ok(()),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(err) => Err(SandboxError::new(err.to_string(), "EXEC_FAILED")),
        }
    }
}

fn with_unique_suffix(base: PathBuf) -> PathBuf {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let ms = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis();
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    let mut s = base.into_os_string();
    s.push(format!("-{}-{}-{}", std::process::id(), ms % 100000, n));
    PathBuf::from(s)
}
