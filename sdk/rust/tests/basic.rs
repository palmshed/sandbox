//! F1 milestone: create sandbox, execute command, capture result, destroy.
//! Plus filesystem round-trip, timeout, cancellation, and error codes.

use palmshed_sandbox::{ExecOptions, ExecutionStatus, Sandbox, SandboxOptions};
use std::sync::{Arc, Mutex};

#[tokio::test]
async fn create_exec_result_destroy() {
    let sb = Sandbox::create(SandboxOptions::default()).await.unwrap();
    let ex = sb.exec_simple("echo hello-rust").await.unwrap();
    assert!(ex.id().starts_with("exec_"));
    assert!(ex.uri().starts_with("sandbox://execution/exec_"));
    assert_eq!(ex.status(), ExecutionStatus::Running);
    ex.wait().await;
    assert_eq!(ex.status(), ExecutionStatus::Completed);
    assert_eq!(ex.exit_code(), 0);
    assert!(ex.stdout().contains("hello-rust"));
    assert_eq!(ex.truncated(), false);
    let meta = ex.metadata().unwrap();
    assert_eq!(meta.backend, "native");
    assert_eq!(meta.spec_version, palmshed_sandbox::SPEC_VERSION);
    assert!(!meta.timed_out);
    let result = ex.result().unwrap();
    assert_eq!(result.exit_code, 0);
    sb.destroy().await.unwrap();
}

#[tokio::test]
async fn filesystem_roundtrip_and_traversal_rejected() {
    let sb = Sandbox::create(SandboxOptions::default()).await.unwrap();
    sb.write_file("sub/dir.txt", b"data").await.unwrap();
    assert_eq!(sb.read_file("sub/dir.txt").await.unwrap(), b"data");
    assert!(sb.read_file("../escape.txt").await.is_err());
    assert!(sb.read_file("/etc/hostname").await.is_err());
    let err = sb.read_file("../escape.txt").await.unwrap_err();
    assert_eq!(err.code, "FS_ERROR");
    sb.destroy().await.unwrap();
}

#[tokio::test]
async fn failing_command_reports_failed() {
    let sb = Sandbox::create(SandboxOptions::default()).await.unwrap();
    let ex = sb.exec_simple("exit 3").await.unwrap();
    ex.wait().await;
    assert_eq!(ex.status(), ExecutionStatus::Failed);
    assert_eq!(ex.exit_code(), 3);
    sb.destroy().await.unwrap();
}

#[tokio::test]
async fn timeout_kills_and_reports_timedout() {
    let sb = Sandbox::create(SandboxOptions::default()).await.unwrap();
    let ex = sb
        .exec("sleep 30", ExecOptions { timeout: Some(500), ..Default::default() })
        .await
        .unwrap();
    ex.wait().await;
    assert_eq!(ex.status(), ExecutionStatus::TimedOut);
    assert!(ex.timed_out());
    sb.destroy().await.unwrap();
}

#[tokio::test]
async fn cancel_transitions_to_cancelled() {
    let sb = Sandbox::create(SandboxOptions::default()).await.unwrap();
    let ex = sb.exec_simple("sleep 30").await.unwrap();
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    ex.cancel().await;
    ex.wait().await;
    assert_eq!(ex.status(), ExecutionStatus::Cancelled);
    sb.destroy().await.unwrap();
}

#[tokio::test]
async fn streaming_callbacks_observe_chunks() {
    let sb = Sandbox::create(SandboxOptions::default()).await.unwrap();
    let ex = sb.exec_simple("echo stream-me").await.unwrap();
    let seen = Arc::new(Mutex::new(String::new()));
    let seen2 = seen.clone();
    ex.on_stdout(move |chunk| {
        seen2.lock().unwrap().push_str(&chunk);
    });
    ex.wait().await;
    assert!(seen.lock().unwrap().contains("stream-me"));
    sb.destroy().await.unwrap();
}

#[tokio::test]
async fn unknown_backend_fails_honestly() {
    let err = Sandbox::create(SandboxOptions { backend: Some("firecracker".to_string()), ..Default::default() })
        .await
        .unwrap_err();
    assert_eq!(err.code, "INVALID_BACKEND");
}

#[tokio::test]
async fn capabilities_report_honestly() {
    let sb = Sandbox::create(SandboxOptions::default()).await.unwrap();
    let caps = sb.capabilities();
    assert!(caps.filesystem);
    assert!(caps.streaming);
    assert!(!caps.remote_execution);
    sb.destroy().await.unwrap();
}
