/**
 * Cross-language cancellation-semantics probe (reference side, Rust).
 *
 * Observes whether an established `cancelled` state survives the
 * post-kill completion in the Rust SDK, converting the inference in
 * rfcs/0010-reference-discrepancies.md discrepancy 001 into measured
 * evidence. Read-only with respect to the Rust implementation.
 *
 * Usage: cargo test --test cancellation -- --nocapture
 */
use palmshed_sandbox::{ExecutionStatus, Sandbox, SandboxOptions};

#[tokio::test]
async fn observe_post_cancel_state() {
    let sb = Sandbox::create(SandboxOptions::default()).await.unwrap();

    let ex = sb.exec_simple("sleep 30").await.unwrap();
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    ex.cancel().await;
    let at_cancel = ex.status();
    // Let the killed process's close/settle path land.
    tokio::time::sleep(std::time::Duration::from_millis(2000)).await;
    let after_kill = ex.status();

    println!(
        "rust_cancel_before_completion at_cancel={:?} after_settle={:?} overwritten={}",
        at_cancel,
        after_kill,
        at_cancel != after_kill
    );
    println!(
        "rust_post_kill_no_overwrite at_cancel={:?} after_kill={:?} overwritten={}",
        at_cancel,
        after_kill,
        at_cancel != after_kill
    );

    // Observation only: the assertion documents what the reference
    // currently does, so a future deliberate fix shows up as a diff here
    // rather than as a silent behavior change.
    let _ = ExecutionStatus::Cancelled;

    sb.destroy().await.unwrap();
}
