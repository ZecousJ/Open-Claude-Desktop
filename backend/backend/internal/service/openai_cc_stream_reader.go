package service

import (
	"errors"
	"io"
	"time"
)

var errCCStreamIdleTimeout = errors.New("upstream chat completion stream data interval timed out")

// Only time a blocked upstream read. Downstream backpressure and time spent
// converting an already received chunk must not expire a healthy upstream.
type ccStreamIdleReader struct {
	body    io.ReadCloser
	timeout time.Duration
}

func (r *ccStreamIdleReader) Read(p []byte) (int, error) {
	closed := make(chan struct{})
	timer := time.AfterFunc(r.timeout, func() {
		defer close(closed)
		_ = r.body.Close()
	})
	n, err := r.body.Read(p)
	if !timer.Stop() {
		<-closed
		return n, errCCStreamIdleTimeout
	}
	return n, err
}
