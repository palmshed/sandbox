//go:build windows

package sandbox

import (
	"os"
	"os/exec"
	"strings"
	"time"
)

// setProcessGroup is a no-op on Windows: tree termination uses taskkill /T
// instead of a POSIX process group.
func setProcessGroup(cmd *exec.Cmd) {}

// killTree terminates the process tree with taskkill /T /F, matching the
// reference Windows behavior.
func killTree(pid int) {
	_ = exec.Command("taskkill", "/pid", itoa(pid), "/T", "/F").Run()
	time.Sleep(1 * time.Second)
}

func itoa(v int) string {
	if v == 0 {
		return "0"
	}
	neg := v < 0
	if neg {
		v = -v
	}
	var buf [20]byte
	i := len(buf)
	for v > 0 {
		i--
		buf[i] = byte('0' + v%10)
		v /= 10
	}
	if neg {
		i--
		buf[i] = '-'
	}
	return string(buf[i:])
}

// envKeys mirrors the reference contract's Windows set. SystemRoot,
// ComSpec, and UserProfile are required for the runtime to load at all;
// omitting them aborts the child before it can run.
var envKeys = []string{
	"PATH", "SystemRoot", "ComSpec", "USERPROFILE", "HOMEDRIVE", "HOMEPATH",
	"TEMP", "TMP", "LANG", "LC_ALL", "LC_CTYPE",
}

func buildEnv(sandboxEnv, execEnv map[string]string) []string {
	base := os.Environ()
	allowed := make(map[string]bool, len(envKeys))
	for _, k := range envKeys {
		allowed[strings.ToLower(k)] = true
	}
	out := make([]string, 0, len(envKeys)+len(sandboxEnv)+len(execEnv))
	for _, kv := range base {
		k, _, ok := splitKV(kv)
		if ok && allowed[strings.ToLower(k)] {
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

// exitCodeFromState reports the process exit code. Windows has no POSIX
// signal-death convention to map.
func exitCodeFromState(ps *os.ProcessState) int { return ps.ExitCode() }

func splitKV(kv string) (string, string, bool) {
	for i := 0; i < len(kv); i++ {
		if kv[i] == '=' {
			return kv[:i], kv[i+1:], true
		}
	}
	return "", "", false
}
