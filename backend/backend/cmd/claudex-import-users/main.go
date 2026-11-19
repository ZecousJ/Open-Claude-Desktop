// CLAUDEX: ZMIG — import users exported from ZecousAI into this Sub2API fork.
//
//	claudex-import-users --file users.json [--dry-run] [--update-existing]
//	                     [--balance-per-cny 1] [--report report.json]
//
// It reads the same config.yaml / environment as the server (like jwtgen),
// matches records by e-mail (idempotent), keeps legacy password hashes as is
// (verified and upgraded at sign-in, see internal/claudex/legacypw) and credits
// credit_cny through AdminService.UpdateUserBalance, which writes the balance
// history record. The report maps old ids to new user ids. See
// docs/admin-backend.md ("Migrating users from ZecousAI").
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"
	"time"

	_ "github.com/Wei-Shaw/sub2api/ent/runtime"
	"github.com/Wei-Shaw/sub2api/internal/claudex/usermigrate"
	"github.com/Wei-Shaw/sub2api/internal/config"
	"github.com/Wei-Shaw/sub2api/internal/pkg/pagination"
	"github.com/Wei-Shaw/sub2api/internal/repository"
	"github.com/Wei-Shaw/sub2api/internal/service"
)

func main() {
	file := flag.String("file", "", "JSON array of users to import (required)")
	dryRun := flag.Bool("dry-run", false, "print what would change without writing")
	updateExisting := flag.Bool("update-existing", false, "refresh users created by an earlier import (username, notes, status, legacy hash)")
	rate := flag.Float64("balance-per-cny", 1, "balance units credited per 1 credit_cny")
	reportPath := flag.String("report", "", "where to write the JSON report with the old id -> new id mapping (default claudex-import-report-<time>.json)")
	concurrency := flag.Int("concurrency", -1, "concurrency of new users (default: the default concurrency setting)")
	rpmLimit := flag.Int("rpm-limit", -1, "RPM limit of new users (default: the default user RPM limit setting)")
	flag.Parse()

	if *file == "" {
		log.Fatal("--file is required")
	}
	f, err := os.Open(*file)
	if err != nil {
		log.Fatalf("open import file: %v", err)
	}
	records, err := usermigrate.ParseRecords(f)
	_ = f.Close()
	if err != nil {
		log.Fatal(err)
	}

	cfg, err := config.LoadForBootstrap()
	if err != nil {
		log.Fatalf("load config: %v", err)
	}
	client, sqlDB, err := repository.InitEnt(cfg)
	if err != nil {
		log.Fatalf("initialize database: %v", err)
	}
	defer func() { _ = client.Close() }()

	ctx := context.Background()
	userRepo := repository.NewUserRepository(client, sqlDB)
	redeemRepo := repository.NewRedeemCodeRepository(client)
	settings := service.NewSettingService(repository.NewSettingRepository(client), cfg)
	// Only the balance path is used: it needs the user and redeem-code
	// repositories. Without a SettingService no affiliate rebate is accrued
	// for the migration credit; the server's caches are not touched (new users
	// have no cached balance).
	admin := service.NewAdminService(cfg, userRepo, nil, nil, nil, nil, redeemRepo, nil, nil, nil, nil, nil, nil,
		client, nil, nil, nil, nil, nil, nil, nil, nil, nil)

	opts := usermigrate.Options{
		DryRun:         *dryRun,
		UpdateExisting: *updateExisting,
		BalancePerCNY:  *rate,
		Concurrency:    *concurrency,
		RPMLimit:       *rpmLimit,
	}
	if opts.Concurrency < 0 {
		opts.Concurrency = settings.GetDefaultConcurrency(ctx)
	}
	if opts.RPMLimit < 0 {
		opts.RPMLimit = settings.GetDefaultUserRPMLimit(ctx)
	}

	store := &repoStore{users: userRepo, redeem: redeemRepo, admin: admin}
	rep, err := usermigrate.Run(ctx, store, records, opts)
	if rep != nil {
		printReport(rep)
		path := *reportPath
		if path == "" {
			suffix := ""
			if *dryRun {
				suffix = "-dry-run"
			}
			path = fmt.Sprintf("claudex-import-report-%s%s.json", time.Now().UTC().Format("20060102T150405Z"), suffix)
		}
		if werr := writeReport(path, rep); werr != nil {
			log.Printf("write report: %v", werr)
		} else {
			abs, _ := filepath.Abs(path)
			fmt.Printf("report (contains e-mail addresses, mode 0600): %s\n", abs)
		}
	}
	if err != nil {
		log.Fatalf("import stopped: %v", err)
	}
	if rep.Failed() {
		os.Exit(2)
	}
}

func printReport(rep *usermigrate.Report) {
	mode := "IMPORT"
	if rep.DryRun {
		mode = "DRY RUN (nothing written)"
	}
	fmt.Printf("%s: %d records, balance per CNY %v\n", mode, rep.Summary.Total, rep.BalancePerCNY)
	for _, it := range rep.Items {
		line := fmt.Sprintf("#%d %-12s %s", it.Index, it.Action, it.Email)
		if it.OldID != "" {
			line += " old_id=" + it.OldID
		}
		if it.NewID != 0 {
			line += fmt.Sprintf(" new_id=%d", it.NewID)
		}
		if it.Status != "" && it.Status != service.StatusActive {
			line += " status=" + it.Status
		}
		if it.HashScheme != "" {
			line += " hash=" + it.HashScheme
		}
		if it.CreditAction != usermigrate.CreditNone {
			line += fmt.Sprintf(" credit=%v(%s)", it.CreditAmount, it.CreditAction)
		}
		fmt.Println(line)
		if it.Conflict != "" {
			fmt.Println("    conflict: " + it.Conflict)
		}
		if it.Error != "" {
			fmt.Println("    error: " + it.Error)
		}
		for _, w := range it.Warnings {
			fmt.Println("    warning: " + w)
		}
	}
	s := rep.Summary
	fmt.Printf("summary: created=%d updated=%d skipped=%d conflicts=%d invalid=%d errors=%d credited=%d (total %v) warnings=%d\n",
		s.Created, s.Updated, s.Skipped, s.Conflicts, s.Invalid, s.Errors, s.Credited, s.CreditedTotal, s.Warnings)
}

func writeReport(path string, rep *usermigrate.Report) error {
	b, err := json.MarshalIndent(rep, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, append(b, '\n'), 0o600)
}

// repoStore adapts the fork's repositories and admin service to usermigrate.Store.
type repoStore struct {
	users  service.UserRepository
	redeem service.RedeemCodeRepository
	admin  service.AdminService
}

func (s *repoStore) GetUserByEmail(ctx context.Context, email string) (*service.User, error) {
	return s.users.GetByEmail(ctx, email)
}

func (s *repoStore) UsersWithUsername(ctx context.Context, username string) ([]service.User, error) {
	noSubs := false
	var out []service.User
	for page := 1; page <= 20; page++ {
		batch, res, err := s.users.ListWithFilters(ctx,
			pagination.PaginationParams{Page: page, PageSize: 100},
			service.UserListFilters{Search: username, IncludeSubscriptions: &noSubs})
		if err != nil {
			return out, err
		}
		for _, u := range batch {
			if strings.EqualFold(u.Username, username) {
				out = append(out, u)
			}
		}
		if len(batch) < 100 || res == nil || int64(page*100) >= res.Total {
			break
		}
	}
	return out, nil
}

func (s *repoStore) CreateUser(ctx context.Context, user *service.User) error {
	return s.users.Create(ctx, user)
}

func (s *repoStore) UpdateUser(ctx context.Context, user *service.User, fields service.UserUpdateFields) error {
	return s.users.Update(ctx, user, fields)
}

func (s *repoStore) MigrationCredited(ctx context.Context, userID int64) (bool, error) {
	for page := 1; ; page++ {
		batch, res, err := s.redeem.ListByUserPaginated(ctx, userID,
			pagination.PaginationParams{Page: page, PageSize: 100}, service.AdjustmentTypeAdminBalance)
		if err != nil {
			return false, err
		}
		for _, rc := range batch {
			if strings.HasPrefix(rc.Notes, usermigrate.Marker) {
				return true, nil
			}
		}
		if len(batch) < 100 || res == nil || int64(page*100) >= res.Total {
			return false, nil
		}
	}
}

func (s *repoStore) CreditBalance(ctx context.Context, userID int64, amount float64, notes string) error {
	if _, err := s.admin.UpdateUserBalance(ctx, userID, amount, "add", notes); err != nil {
		return err
	}
	// UpdateUserBalance only logs a failed balance-history write. The record is
	// what makes the credit idempotent, so make sure it exists before moving on.
	if ok, err := s.MigrationCredited(ctx, userID); err == nil && ok {
		return nil
	}
	code, err := service.GenerateRedeemCode()
	if err != nil {
		return fmt.Errorf("balance added but the history record is missing (generate code: %v); do not re-run for user %d before adding it by hand", err, userID)
	}
	now := time.Now()
	record := &service.RedeemCode{
		Code:   code,
		Type:   service.AdjustmentTypeAdminBalance,
		Value:  amount,
		Status: service.StatusUsed,
		UsedBy: &userID,
		UsedAt: &now,
		Notes:  notes,
	}
	if err := s.redeem.Create(ctx, record); err != nil {
		return fmt.Errorf("balance added but the history record is missing (%v); do not re-run for user %d before adding it by hand", err, userID)
	}
	return nil
}
