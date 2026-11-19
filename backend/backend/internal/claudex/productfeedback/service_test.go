package productfeedback

import (
	"context"
	"errors"
	"html"
	"strings"
	"sync"
	"testing"
	"time"
)

// Memory receipts are explicitly a unit-test fake, never a production queue.
type memoryStore struct {
	mu           sync.Mutex
	rows         map[string]receipt
	users        map[int64]int
	finishFails  bool
	releaseFails bool
	lookupFails  bool
	claimCalls   int
}

func (m *memoryStore) Lookup(_ context.Context, u int64, k string) (receipt, bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.lookupFails {
		return receipt{}, false, errUnavailable
	}
	r, found := m.rows[string(rune(u))+":"+k]
	return r, found, nil
}

func (m *memoryStore) Claim(_ context.Context, u int64, k, h, id string, _ time.Time) (receipt, bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.claimCalls++
	key := string(rune(u)) + ":" + k
	if r, ok := m.rows[key]; ok {
		return r, false, nil
	}
	if m.users[u] >= perHour {
		return receipt{}, false, errLimited
	}
	r := receipt{ID: id, Hash: h, Status: "sending"}
	m.rows[key] = r
	m.users[u]++
	return r, true, nil
}
func (m *memoryStore) Finish(_ context.Context, u int64, k, status string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.finishFails {
		return errors.New("database offline")
	}
	key := string(rune(u)) + ":" + k
	r := m.rows[key]
	r.Status = status
	m.rows[key] = r
	return nil
}
func (m *memoryStore) Release(_ context.Context, u int64, k, id string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	key := string(rune(u)) + ":" + k
	r, ok := m.rows[key]
	if m.releaseFails || !ok || r.ID != id || r.Status != "sending" {
		return errUnavailable
	}
	delete(m.rows, key)
	m.users[u]--
	return nil
}
func fixture(send sendMail) (*processor, *memoryStore) {
	m := &memoryStore{rows: map[string]receipt{}, users: map[int64]int{}}
	return &processor{store: m, prepare: func(context.Context) (sendMail, error) { return send, nil }, newID: func() string { return "00000000-0000-4000-8000-000000000001" }, now: time.Now}, m
}
func input(k string) request {
	return request{Text: "<script>hello</script>", AppVersion: "1.2.3", RequestID: k}
}
func TestFixedRecipientAndReplay(t *testing.T) {
	in := input("one")
	in.Text += " Reference: cid:claudex-logo"
	calls := 0
	p, _ := fixture(func(_ context.Context, to, subject, body string) error {
		calls++
		if to != Recipient || subject != "Claudex product feedback" || strings.Contains(body, "<script>") || strings.Contains(body, "cid:claudex-logo") || !strings.Contains(html.UnescapeString(body), "<pre>"+in.Text+"</pre>") {
			t.Fatal("unsafe mail", to, subject, body)
		}
		return nil
	})
	for i := 0; i < 2; i++ {
		r, e := p.submit(context.Background(), 17, in)
		if e != nil || r.Status != "sent" {
			t.Fatal(r, e)
		}
	}
	changed := input("one")
	changed.Text = "different"
	if _, e := p.submit(context.Background(), 17, changed); !errors.Is(e, errConflict) {
		t.Fatal(e)
	}
	if calls != 1 {
		t.Fatal(calls)
	}
}
func TestUnknownNeverResends(t *testing.T) {
	calls := 0
	p, _ := fixture(func(context.Context, string, string, string) error { calls++; return errors.New("lost DATA response") })
	for i := 0; i < 2; i++ {
		if _, e := p.submit(context.Background(), 17, input("one")); !errors.Is(e, errUnknown) {
			t.Fatal(e)
		}
	}
	if calls != 1 {
		t.Fatal(calls)
	}
}
func TestFinishFailureLeavesSendingAndBlocksReplay(t *testing.T) {
	calls := 0
	p, m := fixture(func(context.Context, string, string, string) error { calls++; return nil })
	m.finishFails = true
	for i := 0; i < 2; i++ {
		if _, e := p.submit(context.Background(), 17, input("one")); !errors.Is(e, errUnknown) {
			t.Fatal(e)
		}
	}
	if calls != 1 {
		t.Fatal(calls)
	}
}
func TestNotConfiguredDoesNotClaimOrSend(t *testing.T) {
	p, m := fixture(func(context.Context, string, string, string) error { t.Fatal("send"); return nil })
	p.prepare = func(context.Context) (sendMail, error) { return nil, errUnavailable }
	if _, e := p.submit(context.Background(), 17, input("one")); !errors.Is(e, errUnavailable) || (len(m.rows) != 0 || m.claimCalls != 0) {
		t.Fatal(e, m.rows)
	}
}
func TestAccountIsolationAndQuota(t *testing.T) {
	calls := 0
	p, _ := fixture(func(context.Context, string, string, string) error { calls++; return nil })
	for i := 0; i < perHour; i++ {
		if _, e := p.submit(context.Background(), 17, input(string(rune('a'+i)))); e != nil {
			t.Fatal(e)
		}
	}
	if _, e := p.submit(context.Background(), 17, input("overflow")); !errors.Is(e, errLimited) {
		t.Fatal(e)
	}
	if _, e := p.submit(context.Background(), 18, input("a")); e != nil {
		t.Fatal(e)
	}
	if calls != perHour+1 {
		t.Fatal(calls)
	}
}
func TestConcurrentSameRequestSendsOnce(t *testing.T) {
	started, finish := make(chan struct{}), make(chan struct{})
	p, _ := fixture(func(context.Context, string, string, string) error { close(started); <-finish; return nil })
	done := make(chan error, 1)
	go func() { _, e := p.submit(context.Background(), 17, input("one")); done <- e }()
	<-started
	if _, e := p.submit(context.Background(), 17, input("one")); !errors.Is(e, errUnknown) {
		t.Fatal(e)
	}
	close(finish)
	if e := <-done; e != nil {
		t.Fatal(e)
	}
}

func TestReplaySurvivesConfigurationLoss(t *testing.T) {
	for _, status := range []string{"sent", "unknown", "sending"} {
		t.Run(status, func(t *testing.T) {
			calls := 0
			p, m := fixture(func(context.Context, string, string, string) error {
				calls++
				if status == "unknown" {
					return errUnknown
				}
				return nil
			})
			m.finishFails = status == "sending"
			first, _ := p.submit(context.Background(), 17, input("one"))
			p.prepare = func(context.Context) (sendMail, error) {
				t.Fatal("historical replay checked SMTP")
				return nil, errUnavailable
			}
			r, err := p.submit(context.Background(), 17, input("one"))
			if r.ID != first.ID || calls != 1 || m.claimCalls != 1 {
				t.Fatal(r, calls, m.claimCalls)
			}
			if status == "sent" && err != nil {
				t.Fatal(err)
			}
			if status != "sent" && !errors.Is(err, errUnknown) {
				t.Fatal(err)
			}
			changed := input("one")
			changed.Text = "different"
			if _, err = p.submit(context.Background(), 17, changed); !errors.Is(err, errConflict) {
				t.Fatal(err)
			}
			p.prepare = func(context.Context) (sendMail, error) { return nil, errUnavailable }
			if _, err = p.submit(context.Background(), 18, input("one")); !errors.Is(err, errUnavailable) {
				t.Fatal("cross-owner receipt", err)
			}
			if m.claimCalls != 1 {
				t.Fatal("missing config claimed")
			}
		})
	}
}
func TestLookupFailureDoesNotPrepareClaimOrSend(t *testing.T) {
	p, m := fixture(func(context.Context, string, string, string) error { t.Fatal("send"); return nil })
	m.lookupFails = true
	p.prepare = func(context.Context) (sendMail, error) { t.Fatal("prepare"); return nil, nil }
	if _, err := p.submit(context.Background(), 17, input("one")); !errors.Is(err, errUnavailable) || m.claimCalls != 0 {
		t.Fatal(err, m.claimCalls)
	}
}
func TestClaimRechecksWinnerAfterLookupMiss(t *testing.T) {
	for _, same := range []bool{true, false} {
		t.Run(map[bool]string{true: "same payload replay", false: "changed payload conflict"}[same], func(t *testing.T) {
			calls := 0
			p, m := fixture(func(context.Context, string, string, string) error { calls++; return nil })
			other := *p
			p.prepare = func(ctx context.Context) (sendMail, error) {
				in := input("one")
				if !same {
					in.Text = "competing content"
				}
				if _, err := other.submit(ctx, 17, in); err != nil {
					t.Fatal(err)
				}
				return func(context.Context, string, string, string) error { t.Fatal("loser sent"); return nil }, nil
			}
			_, err := p.submit(context.Background(), 17, input("one"))
			if same && err != nil || !same && !errors.Is(err, errConflict) {
				t.Fatal(err)
			}
			if calls != 1 || m.claimCalls != 2 {
				t.Fatal(calls, m.claimCalls)
			}
		})
	}
}

func TestClaimWinnerUnknownAfterLookupMiss(t *testing.T) {
	for _, status := range []string{"unknown", "sending"} {
		t.Run(status, func(t *testing.T) {
			calls := 0
			p, m := fixture(func(context.Context, string, string, string) error {
				calls++
				if status == "unknown" {
					return errUnknown
				}
				return nil
			})
			m.finishFails = status == "sending"
			other := *p
			p.prepare = func(ctx context.Context) (sendMail, error) {
				if _, err := other.submit(ctx, 17, input("one")); !errors.Is(err, errUnknown) {
					t.Fatal(err)
				}
				return func(context.Context, string, string, string) error { t.Fatal("loser sent"); return nil }, nil
			}
			if _, err := p.submit(context.Background(), 17, input("one")); !errors.Is(err, errUnknown) {
				t.Fatal(err)
			}
			if calls != 1 || m.claimCalls != 2 {
				t.Fatal(calls, m.claimCalls)
			}
		})
	}
}
