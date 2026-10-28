package service

import (
	"context"
	"testing"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/config"
)

func slowFirstTokenScheduler(t *testing.T) (*defaultOpenAIAccountScheduler, *time.Time) {
	t.Helper()
	cfg := &config.Config{}
	cfg.Gateway.OpenAIScheduler.StickyEscapeEnabled = true
	cfg.Gateway.OpenAIScheduler.StickyEscapeTTFTMs = 8000
	now := time.Unix(1_800_000_000, 0)
	previous := openAIRuntimeNow
	openAIRuntimeNow = func() time.Time { return now }
	t.Cleanup(func() { openAIRuntimeNow = previous })
	return &defaultOpenAIAccountScheduler{
		service: &OpenAIGatewayService{cfg: cfg},
		stats:   newOpenAIAccountRuntimeStats(),
	}, &now
}

func TestSlowFirstTokenCandidatesSinkBelowHealthyOnes(t *testing.T) {
	scheduler, _ := slowFirstTokenScheduler(t)
	slow, fast := 9000, 7900
	scheduler.stats.report(1, true, &slow)
	scheduler.stats.report(2, true, &fast)
	candidates := []openAIAccountCandidateScore{
		{account: &Account{ID: 1}, score: 2, ttft: 9000, hasTTFT: true},
		{account: &Account{ID: 2}, score: 0.5, ttft: 7900, hasTTFT: true},
		{account: &Account{ID: 3}, score: 0.4},
	}
	scheduler.sinkSlowFirstTokenCandidates(candidates)
	if candidates[0].score >= candidates[2].score {
		t.Fatalf("a candidate over 8 s should sink below the others, scores %v %v", candidates[0].score, candidates[2].score)
	}
	if candidates[1].score != 0.5 || candidates[2].score != 0.4 {
		t.Fatal("candidates under the threshold or without a sample keep their score")
	}
}

func TestAStaleSlowAverageNoLongerSinksAndTheNextSampleStartsOver(t *testing.T) {
	scheduler, now := slowFirstTokenScheduler(t)
	slow := 12000
	scheduler.stats.report(1, true, &slow)
	*now = now.Add(openAITTFTStaleAfter + time.Second)
	candidates := []openAIAccountCandidateScore{{account: &Account{ID: 1}, score: 2, ttft: 12000, hasTTFT: true}}
	scheduler.sinkSlowFirstTokenCandidates(candidates)
	if candidates[0].score != 2 {
		t.Fatal("an account without a recent sample is measured again, not sunk")
	}
	if _, _, _, escape := scheduler.shouldEscapeStickyAccount(1, scheduler.service.openAIStickyEscapeConfig()); escape {
		t.Fatal("a stale average does not move sticky sessions either")
	}
	fast := 2000
	scheduler.stats.report(1, true, &fast)
	if _, ttft, _ := scheduler.stats.snapshot(1); ttft != 2000 {
		t.Fatalf("the first sample after a gap starts a fresh average, got %v", ttft)
	}
}

func TestStickySessionsLeaveADearAccountForAHealthyCheaperOne(t *testing.T) {
	groupID := int64(42)
	rate := func(v float64) *float64 { return &v }
	account := func(id int64, r float64) Account {
		return Account{
			ID: id, Platform: PlatformOpenAI, Type: AccountTypeAPIKey, Status: StatusActive,
			Schedulable: true, Concurrency: 5, GroupIDs: []int64{groupID}, RateMultiplier: rate(r),
		}
	}
	dear, cheap, similar := account(1, 0.25), account(2, 0.17), account(3, 0.22)
	cfg := &config.Config{}
	cfg.Gateway.OpenAIScheduler.StickyEscapeEnabled = true
	cfg.Gateway.OpenAIScheduler.StickyEscapeTTFTMs = 8000
	cfg.Gateway.OpenAIScheduler.StickyEscapeErrorRate = 0.5
	cfg.Gateway.OpenAIWS.SchedulerScoreWeights.Priority = 1
	cfg.Gateway.OpenAIWS.SchedulerScoreWeights.UpstreamCost = 4
	svc := &OpenAIGatewayService{
		accountRepo: schedulerTestOpenAIAccountRepo{accounts: []Account{dear, cheap, similar}},
		cfg:         cfg,
	}
	stats := newOpenAIAccountRuntimeStats()
	scheduler := &defaultOpenAIAccountScheduler{service: svc, stats: stats}
	req := OpenAIAccountScheduleRequest{GroupID: &groupID, Platform: PlatformOpenAI, UseUpstreamTokenCost: true}
	escape := svc.openAIStickyEscapeConfig()

	// The cheaper account has no fresh measurement yet: the session stays.
	if scheduler.shouldEscapeStickyForCost(context.Background(), &dear, req, escape) {
		t.Fatal("an unmeasured cheaper account does not take a moved session")
	}
	fast, slow := 3000, 12000
	stats.report(cheap.ID, true, &slow)
	if scheduler.shouldEscapeStickyForCost(context.Background(), &dear, req, escape) {
		t.Fatal("a slow cheaper account does not take a moved session")
	}
	stats.report(similar.ID, true, &fast)
	if scheduler.shouldEscapeStickyForCost(context.Background(), &dear, req, escape) {
		t.Fatal("an account less than 20% cheaper is not worth the lost cache")
	}
	for i := 0; i < 10; i++ {
		stats.report(cheap.ID, true, &fast)
	}
	if !scheduler.shouldEscapeStickyForCost(context.Background(), &dear, req, escape) {
		t.Fatal("a healthy account at 0.17 against 0.25 takes the session")
	}
	if scheduler.shouldEscapeStickyForCost(context.Background(), &cheap, req, escape) {
		t.Fatal("the cheap account's own sessions stay")
	}
	req.UseUpstreamTokenCost = false
	if scheduler.shouldEscapeStickyForCost(context.Background(), &dear, req, escape) {
		t.Fatal("without cost-aware scheduling sessions stay")
	}
}
