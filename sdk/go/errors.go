package sandbox

import "fmt"

// Stable error codes shared across SDK implementations.
const (
	CodeExecFailed     = "EXEC_FAILED"
	CodeFSError        = "FS_ERROR"
	CodeInvalidBackend = "INVALID_BACKEND"
)

// Error is the base sandbox error with a stable machine-readable code.
type Error struct {
	Code    string
	Message string
}

func (e *Error) Error() string {
	return fmt.Sprintf("%s: %s", e.Code, e.Message)
}

func newError(code, message string) *Error {
	return &Error{Code: code, Message: message}
}
