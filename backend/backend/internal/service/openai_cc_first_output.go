package service

import (
	"sync"
	"time"
)

type ccFirstOutputBudget struct {
	startTime time.Time
	timeout   time.Duration
	model     string
	effort    string
}

type ccFirstOutputBody struct {
	*openAIRequestContextReadCloser
	guard   *openAIFirstOutputHeaderGuard
	budget  ccFirstOutputBudget
	once    sync.Once
	expired bool
}

// stopWait is idempotent: the underlying header guard must only be stopped once.
func (b *ccFirstOutputBody) stopWait() bool {
	b.once.Do(func() { b.expired = b.guard.stopHeaderWait() })
	return b.expired
}

func (b *ccFirstOutputBody) Close() error {
	b.stopWait()
	return b.openAIRequestContextReadCloser.Close()
}
