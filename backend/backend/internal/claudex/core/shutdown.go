package core

import (
	"log/slog"
	"sync"
)

// Shutdown hooks (owner, 2026-10-03: blue-green deploys). When the server is
// told to stop, the hooks run before it stops taking requests: the web host
// closes its runner links and tabs at once, so they dial the instance nginx
// now sends them to while this one finishes its HTTP requests.

var (
	shutdownMu    sync.Mutex
	shutdownHooks []func()
)

// OnShutdown registers a hook RunShutdownHooks calls.
func OnShutdown(hook func()) {
	shutdownMu.Lock()
	defer shutdownMu.Unlock()
	shutdownHooks = append(shutdownHooks, hook)
}

// RunShutdownHooks runs every registered hook once (a hook that panics is
// logged and skipped).
func RunShutdownHooks() {
	shutdownMu.Lock()
	hooks := shutdownHooks
	shutdownHooks = nil
	shutdownMu.Unlock()
	for _, hook := range hooks {
		func() {
			defer func() {
				if r := recover(); r != nil {
					slog.Error("claudex: shutdown hook panicked", "panic", r)
				}
			}()
			hook()
		}()
	}
}
