package bootstrap

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"regexp"
	"sort"
	"sync"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/claudex/core"
	infraerrors "github.com/Wei-Shaw/sub2api/internal/pkg/errors"
)

// Codes in the errors list besides the reasons contributors return (such as
// CLAUDEX_NO_PLAN from the plan resolver).
const (
	// CodeSectionTimeout: the section did not arrive within its 2 s budget.
	CodeSectionTimeout = "CLAUDEX_SECTION_TIMEOUT"
	// CodeSectionFailed: the contributor failed without a reason code,
	// panicked, or returned a value that is not JSON.
	CodeSectionFailed = "CLAUDEX_SECTION_FAILED"
)

// SectionError is one entry of the errors list: a section that is missing
// from the document and why.
type SectionError struct {
	Section string `json:"section"`
	Code    string `json:"code"`
}

var (
	errTimeout = errors.New("bootstrap: section timed out")
	errPanic   = errors.New("bootstrap: section panicked")
	// reasonPattern accepts the upstream/Claudex reason codes that may be
	// shown to the client; anything else becomes CodeSectionFailed.
	reasonPattern = regexp.MustCompile(`^[A-Z][A-Z0-9_]{0,63}$`)
	jsonNull      = []byte("null")
)

// within runs fn with a context that ends after d and returns at the latest
// then, even when fn ignores its context (the goroutine is left to finish on
// its own). A panic in fn becomes an error.
func within[T any](ctx context.Context, d time.Duration, fn func(context.Context) (T, error)) (T, error) {
	ctx, cancel := context.WithTimeout(ctx, d)
	defer cancel()
	type result struct {
		v   T
		err error
	}
	done := make(chan result, 1)
	go func() {
		var r result
		defer func() {
			if p := recover(); p != nil {
				r = result{err: fmt.Errorf("%w: %v", errPanic, p)}
			}
			done <- r
		}()
		v, err := fn(ctx)
		r = result{v: v, err: err}
	}()
	select {
	case r := <-done:
		return r.v, r.err
	case <-ctx.Done():
		select {
		case r := <-done: // finished at the same moment
			return r.v, r.err
		default:
		}
		var zero T
		return zero, errTimeout
	}
}

// sectionCode maps a failure to the code listed in errors.
func sectionCode(err error) string {
	switch {
	case err == nil:
		return CodeSectionFailed
	case errors.Is(err, errTimeout), errors.Is(err, context.DeadlineExceeded), errors.Is(err, context.Canceled):
		return CodeSectionTimeout
	case errors.Is(err, errPanic):
		return CodeSectionFailed
	}
	if reason := infraerrors.Reason(err); reasonPattern.MatchString(reason) {
		return reason
	}
	return CodeSectionFailed
}

// resolvePlan asks the plan resolver (B4) within the section budget. A nil
// plan without an error breaks the resolver contract and counts as a failure.
func (c *Component) resolvePlan(ctx context.Context, userID int64, requested *int64) (*core.PlanRef, error) {
	resolver := c.env.Peers.Plans
	if resolver == nil {
		return nil, errors.New("bootstrap: no plan resolver")
	}
	plan, err := within(ctx, c.timeout, func(ctx context.Context) (*core.PlanRef, error) {
		return resolver.ResolvePlan(ctx, userID, requested)
	})
	if err == nil && plan == nil {
		err = errors.New("bootstrap: plan resolver returned no plan and no error")
	}
	if err != nil {
		if code := sectionCode(err); code != core.ErrNoPlan.Reason {
			slog.Warn("claudex bootstrap: plan resolution failed", "user_id", userID, "code", code, "error", err)
		}
		return nil, err
	}
	return plan, nil
}

// contribution is what one contributor added: its sections as JSON, or the
// failure code of each section it declared.
type contribution struct {
	sections map[string]json.RawMessage
	failed   map[string]string
}

// collect calls every contributor in parallel and merges their sections.
// failures maps a missing section to its code.
func (c *Component) collect(ctx context.Context, bc *core.BootstrapContext) (sections map[string]json.RawMessage, failures map[string]string) {
	contributors := c.env.Contributors
	results := make([]contribution, len(contributors))
	var wg sync.WaitGroup
	for i, contributor := range contributors {
		wg.Add(1)
		go func() {
			defer wg.Done()
			results[i] = c.call(ctx, contributor, bc)
		}()
	}
	wg.Wait()

	sections = map[string]json.RawMessage{}
	failures = map[string]string{}
	for _, r := range results {
		for name, raw := range r.sections {
			if _, dup := sections[name]; !dup {
				sections[name] = raw
			}
		}
		for name, code := range r.failed {
			if _, dup := failures[name]; !dup {
				failures[name] = code
			}
		}
	}
	for name := range sections {
		delete(failures, name)
	}
	return sections, failures
}

// call runs one contributor within its budget and keeps only the sections it
// both declared and owns (core.SectionOwners); ProvideModule already refused
// foreign or duplicate declarations at startup, this also stops a
// contributor that returns keys it did not declare. Everything the
// contributor runs (Name, Sections, BootstrapSections and the JSON encoding
// of its values) is guarded, so a panic fails only its own sections.
func (c *Component) call(ctx context.Context, contributor core.BootstrapContributor, bc *core.BootstrapContext) contribution {
	out := contribution{sections: map[string]json.RawMessage{}, failed: map[string]string{}}
	name, declared := describe(contributor)
	allowed := map[string]bool{}
	for _, section := range declared {
		if owner, known := core.SectionOwners[section]; known && owner == name {
			allowed[section] = true
		}
	}

	// Each contributor gets its own copy of the context so one cannot change
	// what another sees.
	own := *bc
	if bc.Plan != nil {
		plan := *bc.Plan
		own.Plan = &plan
	}
	encoded, err := within(ctx, c.timeout, func(ctx context.Context) (map[string]json.RawMessage, error) {
		values, err := contributor.BootstrapSections(ctx, &own)
		if err != nil {
			return nil, err
		}
		encoded := make(map[string]json.RawMessage, len(values))
		for section, value := range values {
			if !allowed[section] {
				slog.Warn("claudex bootstrap: dropped a section the contributor does not own or did not declare",
					"component", name, "section", section)
				continue
			}
			raw, err := encodeSection(value)
			if err != nil {
				slog.Warn("claudex bootstrap: section is not JSON", "component", name, "section", section, "error", err)
				raw = nil // marks the section as failed
			}
			encoded[section] = raw
		}
		return encoded, nil
	})
	if err != nil {
		code := sectionCode(err)
		slog.Warn("claudex bootstrap: contributor failed", "component", name, "user_id", bc.UserID, "code", code, "error", err)
		for section := range allowed {
			out.failed[section] = code
		}
		return out
	}
	for section, raw := range encoded {
		switch {
		case raw == nil:
			out.failed[section] = CodeSectionFailed
		case bytes.Equal(raw, jsonNull):
			// a nil section is an absent section
		default:
			out.sections[section] = raw
		}
	}
	return out
}

// encodeSection encodes one section value. encoding/json re-panics a panic
// from a MarshalJSON method; recovering here fails only this section instead
// of every section of the contributor.
func encodeSection(value any) (raw json.RawMessage, err error) {
	defer func() {
		if p := recover(); p != nil {
			raw, err = nil, fmt.Errorf("%w: %v", errPanic, p)
		}
	}()
	return json.Marshal(value)
}

// describe returns the contributor's component name and declared sections,
// treating a panic as no name and no sections.
func describe(contributor core.BootstrapContributor) (name string, sections []string) {
	defer func() {
		if recover() != nil {
			name, sections = "", nil
		}
	}()
	if f, ok := contributor.(core.Feature); ok {
		name = f.Name()
	}
	return name, contributor.Sections()
}

// sortedFailures returns the errors list in section order (the list is part
// of the ETag, so its order must be stable). It is never nil.
func sortedFailures(failures map[string]string) []SectionError {
	out := make([]SectionError, 0, len(failures))
	for section, code := range failures {
		out = append(out, SectionError{Section: section, Code: code})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Section < out[j].Section })
	return out
}
