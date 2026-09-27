package sandbox

import "context"

// Sandbox is a handle to one isolated workspace and its backend.
type Sandbox struct {
	backend *nativeBackend
}

// Create creates a sandbox. Only the native backend exists at the F2
// milestone; other names fail honestly rather than falling back.
func Create(ctx context.Context, opts SandboxOptions) (*Sandbox, error) {
	name := "native"
	if opts.Backend != nil {
		name = *opts.Backend
	}
	if name != "native" && name != "" {
		return nil, newError(CodeInvalidBackend,
			"backend '"+name+"' is not available in this SDK build")
	}
	b, err := newNativeBackend(opts)
	if err != nil {
		return nil, err
	}
	return &Sandbox{backend: b}, nil
}

// Capabilities returns the probed backend capability report.
func (s *Sandbox) Capabilities() Capabilities { return s.backend.caps }

// Exec runs a command and returns a live Execution handle.
func (s *Sandbox) Exec(ctx context.Context, command string, opts ExecOptions) (*Execution, error) {
	return s.backend.Exec(ctx, command, opts)
}

// ExecSimple runs a command with default options.
func (s *Sandbox) ExecSimple(ctx context.Context, command string) (*Execution, error) {
	return s.backend.Exec(ctx, command, ExecOptions{})
}

func (s *Sandbox) ReadFile(p string) ([]byte, error)     { return s.backend.ReadFile(p) }
func (s *Sandbox) WriteFile(p string, data []byte) error { return s.backend.WriteFile(p, data) }
func (s *Sandbox) UploadFile(local, remote string) error { return s.backend.UploadFile(local, remote) }
func (s *Sandbox) DownloadFile(remote, local string) error {
	return s.backend.DownloadFile(remote, local)
}

// Destroy kills live trees and removes the workspace.
func (s *Sandbox) Destroy() error { return s.backend.Destroy() }
