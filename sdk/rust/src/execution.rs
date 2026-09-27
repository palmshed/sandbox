//! Live execution handle mirroring TypeScript `Execution`.
//!
//! States: running becomes completed, failed, cancelled, or timedout.
//! Output callbacks fire per chunk while running; retained strings are
//! bounded exactly like the TypeScript contract (16 MiB per stream tail,
//! truncation marker, sticky flag).

use std::sync::{Arc, Mutex};
use tokio::sync::Notify;

use crate::types::{ExecResult, ExecutionMetadata, ExecutionStatus};

/// Maximum retained bytes per stream (matches the TypeScript contract).
pub const MAX_RETAINED_BYTES_PER_STREAM: usize = 16 * 1024 * 1024;

#[derive(Debug, Default)]
struct OutputStore {
    chunks: Vec<String>,
    retained_bytes: usize,
    total_bytes: usize,
    dropped: bool,
}

impl OutputStore {
    fn push(&mut self, chunk: &str) {
        if chunk.is_empty() {
            return;
        }
        let size = chunk.len();
        self.total_bytes += size;
        self.chunks.push(chunk.to_string());
        self.retained_bytes += size;
        while self.chunks.len() > 1 && self.retained_bytes > MAX_RETAINED_BYTES_PER_STREAM {
            let oldest = self.chunks.remove(0);
            self.retained_bytes -= oldest.len();
            self.dropped = true;
        }
        if self.chunks.len() == 1 && self.retained_bytes > MAX_RETAINED_BYTES_PER_STREAM {
            self.retained_bytes = 0;
            self.chunks.clear();
            self.dropped = true;
        }
    }

    fn text(&self) -> String {
        let body: String = self.chunks.concat();
        if !self.dropped {
            return body;
        }
        format!(
            "[output truncated: showing last {} of {} bytes]\n{}",
            self.retained_bytes, self.total_bytes, body
        )
    }
}

type StdoutCallback = Box<dyn Fn(String) + Send + Sync>;

struct State {
    status: ExecutionStatus,
    result: Option<ExecResult>,
    stdout: OutputStore,
    stderr: OutputStore,
    stdout_cbs: Vec<StdoutCallback>,
    stderr_cbs: Vec<StdoutCallback>,
    kill: Option<Box<dyn Fn() + Send + Sync>>,
}

/// Live handle to a running execution. Cloneable; all clones observe the
/// same execution.
#[derive(Clone)]
pub struct Execution {
    id: String,
    _backend: String,
    state: Arc<Mutex<State>>,
    settled: Arc<Notify>,
}

impl Execution {
    pub(crate) fn new(id: String, backend: String) -> Self {
        Self {
            id,
            _backend: backend,
            state: Arc::new(Mutex::new(State {
                status: ExecutionStatus::Running,
                result: None,
                stdout: OutputStore::default(),
                stderr: OutputStore::default(),
                stdout_cbs: Vec::new(),
                stderr_cbs: Vec::new(),
                kill: None,
            })),
            settled: Arc::new(Notify::new()),
        }
    }

    /// Unique execution identifier (`exec_xxxxxxxx`).
    pub fn id(&self) -> String {
        self.id.clone()
    }

    /// Stable cross-service URI: `sandbox://execution/<id>`.
    pub fn uri(&self) -> String {
        format!("sandbox://execution/{}", self.id)
    }

    /// Current lifecycle status.
    pub fn status(&self) -> ExecutionStatus {
        self.state.lock().unwrap().status
    }

    /// Wait until the execution reaches a terminal state.
    pub async fn wait(&self) {
        loop {
            {
                if self.state.lock().unwrap().status != ExecutionStatus::Running {
                    return;
                }
            }
            self.settled.notified().await;
        }
    }

    /// Process exit code; -1 while still running.
    pub fn exit_code(&self) -> i32 {
        self.state.lock().unwrap().result.as_ref().map(|r| r.exit_code).unwrap_or(-1)
    }

    /// True if the execution timed out.
    pub fn timed_out(&self) -> bool {
        self.state.lock().unwrap().result.as_ref().map(|r| r.timed_out).unwrap_or(false)
    }

    /// True once either stream dropped retained bytes (sticky).
    pub fn truncated(&self) -> bool {
        let s = self.state.lock().unwrap();
        s.stdout.dropped || s.stderr.dropped
    }

    /// Retained stdout (bounded; see [`Execution::truncated`]).
    pub fn stdout(&self) -> String {
        self.state.lock().unwrap().stdout.text()
    }

    /// Retained stderr (bounded).
    pub fn stderr(&self) -> String {
        self.state.lock().unwrap().stderr.text()
    }

    /// Retained stdout plus retained stderr.
    pub fn logs(&self) -> String {
        let s = self.state.lock().unwrap();
        s.stdout.text() + &s.stderr.text()
    }

    /// Structured execution metadata once settled, else `None`.
    pub fn metadata(&self) -> Option<ExecutionMetadata> {
        self.state.lock().unwrap().result.as_ref().map(|r| r.metadata.clone())
    }

    /// Full raw result once settled, else `None`.
    pub fn result(&self) -> Option<ExecResult> {
        self.state.lock().unwrap().result.clone()
    }

    /// Register a real-time stdout chunk callback.
    pub fn on_stdout(&self, cb: impl Fn(String) + Send + Sync + 'static) {
        self.state.lock().unwrap().stdout_cbs.push(Box::new(cb));
    }

    /// Register a real-time stderr chunk callback.
    pub fn on_stderr(&self, cb: impl Fn(String) + Send + Sync + 'static) {
        self.state.lock().unwrap().stderr_cbs.push(Box::new(cb));
    }

    /// Cancel the execution: SIGTERM the tree, then SIGKILL after 1s if
    /// still running. Idempotent; transitions to cancelled.
    pub async fn cancel(&self) {
        let kill = {
            let mut s = self.state.lock().unwrap();
            if s.status != ExecutionStatus::Running {
                return;
            }
            s.status = ExecutionStatus::Cancelled;
            s.kill.take()
        };
        if let Some(kill) = kill {
            kill();
        }
        self.settled.notify_waiters();
    }

    pub(crate) fn register_kill(&self, kill: impl Fn() + Send + Sync + 'static) {
        self.state.lock().unwrap().kill = Some(Box::new(kill));
    }

    pub(crate) fn push_stdout(&self, chunk: String) {
        let mut s = self.state.lock().unwrap();
        s.stdout.push(&chunk);
        for cb in &s.stdout_cbs {
            cb(chunk.clone());
        }
    }

    pub(crate) fn push_stderr(&self, chunk: String) {
        let mut s = self.state.lock().unwrap();
        s.stderr.push(&chunk);
        for cb in &s.stderr_cbs {
            cb(chunk.clone());
        }
    }

    pub(crate) fn complete(&self, result: ExecResult) {
        let status = if result.timed_out {
            ExecutionStatus::TimedOut
        } else if result.exit_code == 0 {
            ExecutionStatus::Completed
        } else {
            ExecutionStatus::Failed
        };
        let mut s = self.state.lock().unwrap();
        s.status = status;
        s.result = Some(result);
        drop(s);
        self.settled.notify_waiters();
    }
}
