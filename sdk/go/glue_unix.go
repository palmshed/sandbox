//go:build !windows

package sandbox

import (
	"os"
	"os/exec"
	"syscall"
	"time"
)

// setProcessGroup puts the child in its own process group so the whole
// tree can be signalled with a negative PID.
func setProcessGroup(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
}

// killTree sends SIGTERM to the process group, then SIGKILL after 1s if
// it is still alive. Matches the reference cancel cadence.
func killTree(pid int) {
	pgid, err := syscall.Getpgid(pid)
	if err != nil || pgid <= 0 {
		pgid = pid
	}
	_ = syscall.Kill(-pgid, syscall.SIGTERM)
	time.Sleep(1 * time.Second)
	_ = syscall.Kill(-pgid, syscall.SIGKILL)
}

// envKeys is the minimal host environment carried into workloads. The host
// is never inherited wholesale; explicit values overlay this set.
var envKeys = []string{"PATH", "HOME", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "LC_CTYPE"}

func buildEnv(sandboxEnv, execEnv map[string]string) []string {
	base := os.Environ()
	allowed := make(map[string]bool, len(envKeys))
	for _, k := range envKeys {
		allowed[k] = true
	}
	out := make([]string, 0, len(envKeys)+len(sandboxEnv)+len(execEnv))
	for _, kv := range base {
		k, _, ok := splitKV(kv)
		if ok && allowed[k] {
			out = append(out, kv)
		}
	}
	for k, v := range sandboxEnv {
		out = append(out, k+"="+v)
	}
	for k, v := range execEnv {
		out = append(out, k+"="+v)
	}
	return out
}

// exitCodeFromState maps a process state to the contract exit code: a
// signal death reports the conventional 128 + signal number, matching the
// reference implementation.
func exitCodeFromState(ps *os.ProcessState) int {
	if ws, ok := ps.Sys().(syscall.WaitStatus); ok {
		if ws.Signaled() {
			return 128 + int(ws.Signal())
		}
	}
	return ps.ExitCode()
}

func splitKV(kv string) (string, string, bool) {
	for i := 0; i < len(kv); i++ {
		if kv[i] == '=' {
			return kv[:i], kv[i+1:], true
		}
	}
	return "", "", false
}
