//! Normative contract tests ported from the TypeScript compliance suite.
//!
//! Each case preserves the expected semantics of its source assertion
//! (`compliance/sdk/suite.test.js`, `compliance/backends/native.test.js`).
//! Anything asserted here must hold in both SDKs; platform-divergent
//! behavior is skipped with reason, never weakened to pass.

use palmshed_sandbox::{ExecOptions, ExecutionStatus, Sandbox, SandboxOptions};
use std::sync::{Arc, Mutex};

fn spec_version() -> String {
    let text = include_str!("../../../spec/version.md");
    let start = text.find("**").unwrap() + 2;
    let end = text[start..].find("**").unwrap();
    text[start..start + end].to_string()
}

#[tokio::test]
async fn spec_execution_handle_uri_and_initial_status() {
    let sb = Sandbox::create(SandboxOptions::default()).await.unwrap();
    let ex = sb.exec_simple("echo Compliance").await.unwrap();
    assert!(ex.id().starts_with("exec_"));
    assert!(ex.uri().starts_with("sandbox://execution/exec_"));
    ex.wait().await;
    assert_eq!(ex.status(), ExecutionStatus::Completed);
    sb.destroy().await.unwrap();
}

#[tokio::test]
async fn spec_command_execution_and_exit_code() {
    let sb = Sandbox::create(SandboxOptions::default()).await.unwrap();
    let ex = sb.exec_simple("echo Compliance-Test").await.unwrap();
    ex.wait().await;
    assert_eq!(ex.exit_code(), 0);
    assert!(!ex.timed_out());
    sb.destroy().await.unwrap();
}

#[tokio::test]
async fn spec_execution_metadata() {
    let expected = spec_version();
    let sb = Sandbox::create(SandboxOptions::default()).await.unwrap();
    let ex = sb.exec_simple("echo Metadata").await.unwrap();
    ex.wait().await;
    let meta = ex.metadata().unwrap();
    assert_eq!(meta.backend, "native");
    assert_eq!(meta.spec_version, expected);
    assert!(!meta.started_at.is_empty());
    assert!(!meta.finished_at.is_empty());
    // ISO-8601 UTC with millis, matching the TypeScript shape.
    for stamp in [&meta.started_at, &meta.finished_at] {
        assert!(stamp.ends_with('Z'), "not UTC: {stamp}");
        assert_eq!(stamp.len(), 24, "not yyyy-mm-ddThh:mm:ss.sssZ: {stamp}");
    }
    sb.destroy().await.unwrap();
}

#[tokio::test]
async fn spec_realtime_stdout_streaming() {
    let sb = Sandbox::create(SandboxOptions::default()).await.unwrap();
    let ex = sb.exec_simple("echo Stream-Chunk").await.unwrap();
    let captured = Arc::new(Mutex::new(String::new()));
    let c2 = captured.clone();
    ex.on_stdout(move |chunk| c2.lock().unwrap().push_str(&chunk));
    ex.wait().await;
    assert!(captured.lock().unwrap().contains("Stream-Chunk"));
    sb.destroy().await.unwrap();
}

#[tokio::test]
async fn spec_timeout_enforcement_and_timedout_status() {
    let sb = Sandbox::create(SandboxOptions::default()).await.unwrap();
    sb.write_file("spin.js", b"setTimeout(() => {}, 5000);").await.unwrap();
    let ex = sb
        .exec("node spin.js", ExecOptions { timeout: Some(150), ..Default::default() })
        .await
        .unwrap();
    ex.wait().await;
    assert_eq!(ex.status(), ExecutionStatus::TimedOut);
    assert_eq!(ex.exit_code(), -1);
    assert!(ex.metadata().unwrap().timed_out);
    sb.destroy().await.unwrap();
}

#[tokio::test]
async fn spec_capability_negotiation_flags() {
    let sb = Sandbox::create(SandboxOptions::default()).await.unwrap();
    let caps = sb.capabilities();
    assert!(caps.filesystem);
    assert!(caps.streaming);
    assert!(!caps.remote_execution);
    match caps.os_filesystem_isolation {
        palmshed_sandbox::OsFilesystemIsolationStatus::Supported
        | palmshed_sandbox::OsFilesystemIsolationStatus::Unsupported
        | palmshed_sandbox::OsFilesystemIsolationStatus::Unknown => {}
    }
    sb.destroy().await.unwrap();
}

#[tokio::test]
async fn spec_vfs_isolation_boundary() {
    let sb = Sandbox::create(SandboxOptions::default()).await.unwrap();
    let err = sb.read_file("../../../../etc/hosts").await.unwrap_err();
    assert_eq!(err.code, "FS_ERROR");
    let err = sb.write_file("/etc/evil.txt", b"x").await.unwrap_err();
    assert_eq!(err.code, "FS_ERROR");
    #[cfg(unix)]
    {
        sb.write_file(
            "plant.js",
            b"require('fs').symlinkSync('/etc/hosts','link.txt')",
        )
        .await
        .unwrap();
        let plant = sb.exec_simple("node plant.js").await.unwrap();
        plant.wait().await;
        let err = sb.read_file("link.txt").await.unwrap_err();
        assert_eq!(err.code, "FS_ERROR");
    }
    sb.destroy().await.unwrap();
}

#[tokio::test]
async fn spec_environment_contract() {
    std::env::set_var("HOST_LEAK_VAR", "should-not-leak");
    let sb = Sandbox::create(SandboxOptions {
        env: vec![("EXPLICIT_VAR".to_string(), "injected".to_string())],
        ..Default::default()
    })
    .await
    .unwrap();
    sb.write_file(
        "env.js",
        b"console.log((process.env.HOST_LEAK_VAR||'absent') + ' ' + (process.env.EXPLICIT_VAR||'absent') + ' ' + (process.env.PATH?'path':'nopath'))",
    )
    .await
    .unwrap();
    let ex = sb.exec_simple("node env.js").await.unwrap();
    ex.wait().await;
    assert_eq!(ex.exit_code(), 0);
    assert!(ex.stdout().contains("absent injected path"), "got: {}", ex.stdout());
    std::env::remove_var("HOST_LEAK_VAR");
    sb.destroy().await.unwrap();
}

// ---- Rust-specific contract behavior (binding note section 6) ----

#[tokio::test]
async fn rust_cloned_handles_observe_one_execution() {
    let sb = Sandbox::create(SandboxOptions::default()).await.unwrap();
    let ex = sb.exec_simple("echo shared").await.unwrap();
    let ex2 = ex.clone();
    ex.wait().await;
    ex2.wait().await;
    assert_eq!(ex.status(), ex2.status());
    assert_eq!(ex.stdout(), ex2.stdout());
    assert_eq!(ex.id(), ex2.id());
    sb.destroy().await.unwrap();
}

#[tokio::test]
async fn rust_absent_measurements_stay_absent() {
    // The F1 scope samples no CPU time: None must survive end to end,
    // never collapsing into a default zero.
    let sb = Sandbox::create(SandboxOptions::default()).await.unwrap();
    let ex = sb.exec_simple("echo hi").await.unwrap();
    ex.wait().await;
    let meta = ex.metadata().unwrap();
    assert_eq!(meta.cpu_time_ms, None);
    assert_eq!(ex.result().unwrap().cpu_time_ms, None);
    sb.destroy().await.unwrap();
}

#[tokio::test]
async fn rust_truncated_emitted_deterministically() {
    let sb = Sandbox::create(SandboxOptions::default()).await.unwrap();
    let ex = sb.exec_simple("echo hi").await.unwrap();
    ex.wait().await;
    assert_eq!(ex.result().unwrap().truncated, Some(false));
    assert_eq!(ex.metadata().unwrap().truncated, Some(false));
    sb.destroy().await.unwrap();
}

#[tokio::test]
async fn rust_cancel_is_idempotent_and_wait_is_repeatable() {
    let sb = Sandbox::create(SandboxOptions::default()).await.unwrap();
    let ex = sb.exec_simple("sleep 30").await.unwrap();
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    ex.cancel().await;
    ex.cancel().await;
    ex.wait().await;
    ex.wait().await;
    assert_eq!(ex.status(), ExecutionStatus::Cancelled);
    sb.destroy().await.unwrap();
}

#[tokio::test]
async fn rust_error_codes_are_stable_strings() {
    let sb = Sandbox::create(SandboxOptions::default()).await.unwrap();
    let err = sb.read_file("nope/missing.txt").await.unwrap_err();
    assert_eq!(err.code, "FS_ERROR");
    assert!(err.to_string().contains("FS_ERROR"));
    sb.destroy().await.unwrap();
}
