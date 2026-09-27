package sandbox_test

import (
	"context"
	"encoding/json"
	"fmt"
	"testing"
	"time"

	sandbox "github.com/palmshed/sandbox/sdk/go"
)

// TestCrossLanguageCancellationSemantics runs the same six race scenarios
// the TypeScript probe runs, and asserts the RFC 0009 section 2.1
// normative expectation: the first terminal state observed by the guard
// wins, and a cancelled execution is never overwritten by a later
// natural completion.
func TestCrossLanguageCancellationSemantics(t *testing.T) {
	observed := map[string]any{}

	run := func(name string, fn func(sb *sandbox.Sandbox) (map[string]any, error)) {
		t.Helper()
		sb, err := sandbox.Create(context.Background(), sandbox.SandboxOptions{})
		if err != nil {
			t.Fatalf("%s: create: %v", name, err)
		}
		defer sb.Destroy()
		v, err := fn(sb)
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		observed[name] = v
	}

	// 1. cancel before natural completion: cancelled must persist.
	run("cancel_before_completion", func(sb *sandbox.Sandbox) (map[string]any, error) {
		ex, err := sb.ExecSimple(context.Background(), "sleep 30")
		if err != nil {
			return nil, err
		}
		time.Sleep(200 * time.Millisecond)
		ex.Cancel()
		immediate := string(ex.Status())
		time.Sleep(1500 * time.Millisecond) // let post-kill close land
		return map[string]any{"immediate": immediate, "afterSettle": string(ex.Status())}, nil
	})

	// 2. natural completion wins the race.
	run("completion_wins", func(sb *sandbox.Sandbox) (map[string]any, error) {
		ex, err := sb.ExecSimple(context.Background(), "echo quick")
		if err != nil {
			return nil, err
		}
		ex.Wait()
		atCompletion := string(ex.Status())
		ex.Cancel()
		return map[string]any{"atCompletion": atCompletion, "afterCancel": string(ex.Status()), "exit": ex.ExitCode()}, nil
	})

	// 3. cancel after terminal completion leaves state unchanged.
	run("cancel_after_terminal", func(sb *sandbox.Sandbox) (map[string]any, error) {
		ex, err := sb.ExecSimple(context.Background(), "exit 5")
		if err != nil {
			return nil, err
		}
		ex.Wait()
		before := string(ex.Status())
		ex.Cancel()
		return map[string]any{"before": before, "after": string(ex.Status()), "exit": ex.ExitCode()}, nil
	})

	// 4. repeated cancel is idempotent.
	run("cancel_idempotent", func(sb *sandbox.Sandbox) (map[string]any, error) {
		ex, err := sb.ExecSimple(context.Background(), "sleep 30")
		if err != nil {
			return nil, err
		}
		time.Sleep(150 * time.Millisecond)
		ex.Cancel()
		ex.Cancel()
		ex.Cancel()
		return map[string]any{"status": string(ex.Status())}, nil
	})

	// 5. repeated wait returns the same result.
	run("wait_repeatable", func(sb *sandbox.Sandbox) (map[string]any, error) {
		ex, err := sb.ExecSimple(context.Background(), "echo stable")
		if err != nil {
			return nil, err
		}
		ex.Wait()
		first, _ := json.Marshal([]any{ex.Status(), ex.ExitCode(), ex.Stdout()})
		ex.Wait()
		ex.Wait()
		second, _ := json.Marshal([]any{ex.Status(), ex.ExitCode(), ex.Stdout()})
		return map[string]any{"identical": string(first) == string(second)}, nil
	})

	// 6. post-kill closure must not overwrite an established cancelled state.
	run("post_kill_no_overwrite", func(sb *sandbox.Sandbox) (map[string]any, error) {
		ex, err := sb.ExecSimple(context.Background(), "sleep 30")
		if err != nil {
			return nil, err
		}
		time.Sleep(200 * time.Millisecond)
		ex.Cancel()
		atCancel := string(ex.Status())
		time.Sleep(2000 * time.Millisecond)
		return map[string]any{"atCancel": atCancel, "afterKill": string(ex.Status()), "overwritten": ex.Status() != sandbox.StatusCancelled}, nil
	})

	t.Logf("observed: %s", mustJSON(observed))

	// Normative assertions (RFC 0009 section 2.1).
	one := observed["cancel_before_completion"].(map[string]any)
	if one["afterSettle"] != "cancelled" {
		t.Errorf("cancelled overwritten after settle: %v", one)
	}
	six := observed["post_kill_no_overwrite"].(map[string]any)
	if six["overwritten"] == true {
		t.Errorf("post-kill closure overwrote cancelled: %v", six)
	}
	two := observed["completion_wins"].(map[string]any)
	if two["atCompletion"] != "completed" || two["afterCancel"] != "completed" {
		t.Errorf("completion should win and be stable: %v", two)
	}
	three := observed["cancel_after_terminal"].(map[string]any)
	if three["before"] != three["after"] {
		t.Errorf("cancel after terminal changed state: %v", three)
	}
}

func mustJSON(v any) string {
	b, _ := json.Marshal(v)
	return fmt.Sprintf("%s", b)
}
