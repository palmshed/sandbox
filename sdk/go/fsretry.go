package sandbox

import (
	"errors"
	"io/fs"
	"syscall"
	"time"
)

// retryIO retries through transient filesystem failures.
//
// Windows can surface sharing violations (ERROR_SHARING_VIOLATION) and
// access-denied errors while a just-exited child still holds a handle, or
// while an indexer scans the workspace. These are transient, not contract
// failures, so a short bounded retry keeps behavior honest without
// weakening any assertion. The same class is handled for the reference
// SDK's destroy path.
func retryIO[T any](op func() (T, error)) (T, error) {
	var zero T
	var lastErr error
	for attempt := 0; attempt < 5; attempt++ {
		v, err := op()
		if err == nil {
			return v, nil
		}
		if !isTransient(err) {
			return zero, err
		}
		lastErr = err
		time.Sleep(time.Duration(25*(attempt+1)) * time.Millisecond)
	}
	return zero, lastErr
}

// retryErr retries an operation that only returns an error.
func retryErr(op func() error) error {
	_, err := retryIO(func() (struct{}, error) { return struct{}{}, op() })
	return err
}

func isTransient(err error) bool {
	if errors.Is(err, fs.ErrPermission) {
		return true
	}
	var errno syscall.Errno
	if errors.As(err, &errno) {
		switch errno {
		case syscall.EACCES, syscall.EBUSY, syscall.EAGAIN:
			return true
		}
		// Windows-specific: ERROR_SHARING_VIOLATION (32),
		// ERROR_LOCK_VIOLATION (33), ERROR_ACCESS_DENIED (5).
		if n := uintptr(errno); n == 32 || n == 33 || n == 5 {
			return true
		}
	}
	return false
}
