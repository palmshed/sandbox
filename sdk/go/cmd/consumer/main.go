// Tiny Go consumer: the F2 usability proof.
//
// create sandbox, write workload, exec with streaming, wait, inspect the
// result, destroy. Run with: go run ./cmd/consumer
package main

import (
	"context"
	"fmt"
	"os"
	"time"

	sandbox "github.com/palmshed/sandbox/sdk/go"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "consumer failed:", err)
		os.Exit(1)
	}
}

func run() error {
	ctx := context.Background()
	sb, err := sandbox.Create(ctx, sandbox.SandboxOptions{})
	if err != nil {
		return err
	}
	defer sb.Destroy()

	caps := sb.Capabilities()
	fmt.Printf("capabilities: filesystem=%v streaming=%v osfs=%s\n",
		caps.Filesystem, caps.Streaming, caps.OSFilesystemIsolation)

	if err := sb.WriteFile("hello.js", []byte("console.log('hello from go consumer');")); err != nil {
		return err
	}

	timeout := uint64(15000)
	ex, err := sb.Exec(ctx, "node hello.js", sandbox.ExecOptions{Timeout: &timeout})
	if err != nil {
		return err
	}
	fmt.Printf("execution: %s %s\n", ex.ID(), ex.URI())

	var streamed string
	ex.OnStdout(func(chunk string) { streamed += chunk })
	ex.Wait()

	res := ex.Result()
	if res == nil {
		return fmt.Errorf("nil result after wait")
	}
	fmt.Printf("status=%s exit=%d truncated=%v\n", ex.Status(), ex.ExitCode(), *res.Truncated)
	fmt.Printf("stdout=%q\n", res.Stdout)
	fmt.Printf("streamed=%q\n", streamed)

	if err := sb.Destroy(); err != nil {
		return err
	}
	fmt.Println("destroy ok")
	time.Sleep(50 * time.Millisecond)
	return nil
}
