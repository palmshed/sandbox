//! Tiny Rust consumer: the F1 usability proof.
//!
//! create sandbox, write workload, exec with streaming, wait, inspect the
//! result, destroy. Run with: cargo run --example eval

use palmshed_sandbox::{ExecOptions, Sandbox, SandboxOptions};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let sb = Sandbox::create(SandboxOptions::default()).await?;
    println!("capabilities: filesystem={} streaming={}", sb.capabilities().filesystem, sb.capabilities().streaming);

    sb.write_file("hello.js", b"console.log('hello from rust consumer');").await?;
    let ex = sb
        .exec("node hello.js", ExecOptions::default())
        .await?;
    println!("execution: {} {}", ex.id(), ex.uri());
    ex.on_stdout(|chunk| print!("stream: {chunk}"));
    ex.wait().await;
    println!("status={:?} exit={}", ex.status(), ex.exit_code());
    let result = ex.result().expect("result after wait");
    println!("stdout={:?} truncated={:?}", result.stdout.trim(), result.truncated);
    sb.destroy().await?;
    println!("destroy ok");
    Ok(())
}
