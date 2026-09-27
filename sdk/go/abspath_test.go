package sandbox_test

import (
	"testing"

	sandbox "github.com/palmshed/sandbox/sdk/go"
)

// Absolute host paths are rejected on every platform, including slash-rooted
// paths on Windows where the OS itself would treat them as relative.
// Regression: filepath.IsAbs is platform-selective and silently contained
// "/etc/evil.txt" on Windows instead of rejecting it.
func TestAbsoluteHostPathsRejectedEverywhere(t *testing.T) {
	sb := newSandbox(t)
	for _, p := range []string{
		"/etc/evil.txt",
		`C:\Windows\evil.txt`,
		`C:/Windows/evil.txt`,
		`\\server\share\evil.txt`,
		`\Windows\evil.txt`,
	} {
		if err := sb.WriteFile(p, []byte("x")); err == nil || codeOf(err) != sandbox.CodeFSError {
			t.Errorf("write %q: expected FS_ERROR, got %v", p, err)
		}
		if _, err := sb.ReadFile(p); err == nil || codeOf(err) != sandbox.CodeFSError {
			t.Errorf("read %q: expected FS_ERROR, got %v", p, err)
		}
	}
}
