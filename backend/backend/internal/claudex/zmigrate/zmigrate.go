// Package zmigrate moves ZecousAI accounts to Claudex (owner, 2026-10-03).
//
// A Claudex user whose e-mail also has a ZecousAI account is shown a one-time
// dialog in the apps until they confirm the move. The dialog shows what the
// account is worth; confirming clears the ZecousAI balance and subscriptions
// and credits that amount to the Claudex balance, in the same request.
//
// The ZecousAI side lives on another host. It is reached over SSH with one
// key whose forced command is tools/zecous-migrate/zmigrate.py: that script
// computes the amount (CNY, credited 1:1 as USD) and clears the account in
// one MySQL transaction, and answers a repeated confirm with the recorded
// amount, so a confirm that stopped half-way is finished by the next one.
//
// Routes (user):
//   - GET  /api/v1/claudex/zecous-migration          {state, amount_usd, balance_usd, subscription_usd}
//   - POST /api/v1/claudex/zecous-migration/confirm  {state: "done", amount_usd}
//   - POST /api/v1/claudex/zecous-migration/confirm-v1  transactional confirmation
//
// state is "none" (no ZecousAI account, or the move is not set up on this
// server), "pending" (the dialog shows) or "done".
//
// Settings (environment): CLAUDEX_ZMIGRATE_SSH_TARGET (user@host),
// CLAUDEX_ZMIGRATE_SSH_KEY, CLAUDEX_ZMIGRATE_KNOWN_HOSTS, and
// CLAUDEX_ZMIGRATE_SNAPSHOT (snapshot.go: the quotes taken from the ZecousAI
// database before its server closed on 2026-10-15, answered when the server
// cannot be reached). Without a target or a snapshot the component answers
// "none" and the dialog never shows.
package zmigrate

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"time"

	dbent "github.com/Wei-Shaw/sub2api/ent"
	"github.com/Wei-Shaw/sub2api/ent/redeemcode"
	"github.com/Wei-Shaw/sub2api/internal/claudex/core"
	infraerrors "github.com/Wei-Shaw/sub2api/internal/pkg/errors"
	"github.com/Wei-Shaw/sub2api/internal/pkg/response"
	"github.com/Wei-Shaw/sub2api/internal/service"

	"github.com/gin-gonic/gin"
	"github.com/shopspring/decimal"
)

// NoteMarker starts the notes of the credit's balance-history record.
const NoteMarker = "[claudex-migration zecousai] dialog"

// Answer is what zmigrate.py prints.
type Answer struct {
	OK              bool             `json:"ok"`
	Error           string           `json:"error,omitempty"`
	Found           bool             `json:"found"`
	Migrated        bool             `json:"migrated"`
	TotalCNY        string           `json:"total_cny"`
	BalanceCNY      string           `json:"balance_cny"`
	SubscriptionCNY string           `json:"subscription_cny"`
	ClaudexUserID   string           `json:"claudex_user_id,omitempty"`
	Subscriptions   []map[string]any `json:"subscriptions,omitempty"`
}

// Remote runs the ZecousAI side.
type Remote interface {
	Quote(ctx context.Context, email string) (Answer, error)
	Confirm(ctx context.Context, email string, userID int64) (Answer, error)
}

// Status is the GET answer.
type Status struct {
	MigrationProtocol int     `json:"migration_protocol"`
	State             string  `json:"state"`
	AmountUSD         float64 `json:"amount_usd"`
	BalanceUSD        float64 `json:"balance_usd"`
	SubscriptionUSD   float64 `json:"subscription_usd"`
}

func replyStatus(g *gin.Context, status Status) {
	status.MigrationProtocol = 1
	response.Success(g, status)
}

var (
	errUnavailable = infraerrors.ServiceUnavailable("CLAUDEX_ZMIGRATE_UNAVAILABLE", "The move from ZecousAI is unavailable right now. Try again later.")
	errNothing     = infraerrors.NotFound("CLAUDEX_ZMIGRATE_NONE", "There is no ZecousAI account to move.")
	errSignIn      = infraerrors.Unauthorized("UNAUTHORIZED", "Sign in first.")
)

// Component is the ZecousAI move.
type Component struct {
	env    *core.Env
	remote Remote
}

// New builds the component from the environment's settings.
func New(env *core.Env) *Component {
	c := &Component{env: env}
	var primary Remote
	if target := strings.TrimSpace(os.Getenv("CLAUDEX_ZMIGRATE_SSH_TARGET")); target != "" {
		primary = &sshRemote{
			target:     target,
			key:        strings.TrimSpace(os.Getenv("CLAUDEX_ZMIGRATE_SSH_KEY")),
			knownHosts: strings.TrimSpace(os.Getenv("CLAUDEX_ZMIGRATE_KNOWN_HOSTS")),
		}
	}
	c.remote = withSnapshot(primary, strings.TrimSpace(os.Getenv("CLAUDEX_ZMIGRATE_SNAPSHOT")))
	return c
}

// Name implements core.Feature.
func (c *Component) Name() string { return core.NameZecousMigration }

// RegisterUserRoutes implements core.UserRouter.
func (c *Component) RegisterUserRoutes(g *gin.RouterGroup) {
	g.GET("/zecous-migration", c.getStatus)
	g.POST("/zecous-migration/confirm", c.postConfirm)
	g.POST("/zecous-migration/confirm-v1", c.postConfirm)
}

func (c *Component) ready() bool {
	return c.remote != nil && c.env != nil && c.env.DB != nil && c.env.EntClient != nil &&
		c.env.UserRepo != nil && c.env.MigrationBalance != nil && c.env.RedeemCodeRepo != nil
}

func (a Answer) valuation(state string) (Status, error) {
	amounts := [3]decimal.Decimal{}
	for i, raw := range []string{a.TotalCNY, a.BalanceCNY, a.SubscriptionCNY} {
		amount, err := decimal.NewFromString(strings.TrimSpace(raw))
		if err != nil || amount.IsNegative() || !amount.LessThan(decimal.New(1, 12)) {
			return Status{}, errors.New("zmigrate: invalid account valuation")
		}
		amounts[i] = amount.Round(2)
	}
	if !amounts[0].Equal(amounts[1].Add(amounts[2])) || !amounts[0].LessThan(decimal.New(1, 12)) {
		return Status{}, errors.New("zmigrate: invalid account valuation")
	}
	return Status{
		State:           state,
		AmountUSD:       amounts[0].InexactFloat64(),
		BalanceUSD:      amounts[1].InexactFloat64(),
		SubscriptionUSD: amounts[2].InexactFloat64(),
	}, nil
}

type migrationRow struct {
	state  string
	email  string
	amount float64
	detail []byte
}

func (r migrationRow) creditedStatus() Status {
	var answer Answer
	if json.Unmarshal(r.detail, &answer) == nil {
		if status, err := answer.valuation("done"); err == nil && status.AmountUSD == r.amount {
			return status
		}
	}
	return Status{State: "done", AmountUSD: r.amount}
}

type migrationQueryer interface {
	QueryContext(context.Context, string, ...any) (*sql.Rows, error)
}

func readMigration(ctx context.Context, db migrationQueryer, userID int64, lock bool) (migrationRow, error) {
	query := `SELECT state, email, amount_usd, detail FROM claudex_zecous_migrations WHERE user_id = $1`
	if lock {
		query += ` FOR UPDATE`
	}
	rows, err := db.QueryContext(ctx, query, userID)
	if err != nil {
		return migrationRow{}, err
	}
	defer rows.Close()
	if !rows.Next() {
		return migrationRow{}, rows.Err()
	}
	var row migrationRow
	err = rows.Scan(&row.state, &row.email, &row.amount, &row.detail)
	return row, err
}

func (c *Component) userEmail(ctx context.Context, userID int64) (string, error) {
	u, err := c.env.UserRepo.GetByID(ctx, userID)
	if errors.Is(err, service.ErrUserNotFound) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	if u == nil {
		return "", nil
	}
	return strings.ToLower(strings.TrimSpace(u.Email)), nil
}

func (c *Component) getStatus(g *gin.Context) {
	userID, ok := core.Subject(g)
	if !ok {
		response.ErrorFrom(g, errSignIn)
		return
	}
	if !c.ready() {
		replyStatus(g, Status{State: "none"})
		return
	}
	ctx := g.Request.Context()
	row, err := readMigration(ctx, c.env.DB, userID, false)
	if err != nil {
		response.ErrorFrom(g, errUnavailable.WithCause(err))
		return
	}
	if row.state == "credited" {
		replyStatus(g, row.creditedStatus())
		return
	}
	email := row.email
	if email == "" {
		email, err = c.userEmail(ctx, userID)
		if err != nil {
			response.ErrorFrom(g, errUnavailable.WithCause(err))
			return
		}
		if email == "" {
			replyStatus(g, Status{State: "none"})
			return
		}
		var claimed bool
		err = c.env.DB.QueryRowContext(ctx, `SELECT EXISTS (SELECT 1 FROM claudex_zecous_migrations WHERE LOWER(BTRIM(email)) = $1 AND user_id <> $2)`, email, userID).Scan(&claimed)
		if err != nil {
			response.ErrorFrom(g, errUnavailable.WithCause(err))
			return
		}
		if claimed {
			replyStatus(g, Status{State: "none"})
			return
		}
	}
	answer, err := c.remote.Quote(ctx, email)
	if err != nil {
		// The dialog waits for the next start rather than showing a wrong amount.
		response.ErrorFrom(g, errUnavailable.WithCause(err))
		return
	}
	if !answer.Found || !answer.belongsTo(userID) {
		replyStatus(g, Status{State: "none"})
		return
	}
	// Moved on the ZecousAI side but not credited yet (a confirm stopped
	// half-way): the dialog shows again and confirming finishes it.
	status, err := answer.valuation("pending")
	if err != nil {
		response.ErrorFrom(g, errUnavailable.WithCause(err))
		return
	}
	replyStatus(g, status)
}

func (a Answer) belongsTo(userID int64) bool {
	return a.ClaudexUserID == "" || a.ClaudexUserID == strconv.FormatInt(userID, 10)
}

func (c *Component) postConfirm(g *gin.Context) {
	userID, ok := core.Subject(g)
	if !ok {
		response.ErrorFrom(g, errSignIn)
		return
	}
	if !c.ready() {
		response.ErrorFrom(g, errUnavailable)
		return
	}
	ctx := g.Request.Context()
	status, err := c.confirm(ctx, userID)
	if err != nil {
		response.ErrorFrom(g, err)
		return
	}
	if status.AmountUSD > 0 {
		c.invalidateBalance(ctx, userID)
	}
	replyStatus(g, status)
}

// confirm runs the move for one user; safe to repeat.
func (c *Component) confirm(ctx context.Context, userID int64) (Status, error) {
	row, err := readMigration(ctx, c.env.DB, userID, false)
	if err != nil {
		return Status{}, errUnavailable.WithCause(err)
	}
	if row.state == "" {
		email, err := c.userEmail(ctx, userID)
		if err != nil {
			return Status{}, errUnavailable.WithCause(err)
		}
		if email == "" {
			return Status{}, errNothing
		}
		if _, err := c.env.DB.ExecContext(ctx,
			`INSERT INTO claudex_zecous_migrations (user_id, email, state) VALUES ($1, $2, 'confirming') ON CONFLICT DO NOTHING`,
			userID, email); err != nil {
			return Status{}, errUnavailable.WithCause(err)
		}
		row, err = readMigration(ctx, c.env.DB, userID, false)
		if err != nil {
			return Status{}, errUnavailable.WithCause(err)
		}
		if row.state == "" {
			return Status{}, errNothing
		}
	}
	if row.state == "credited" {
		return row.creditedStatus(), nil
	}
	answer, err := c.remote.Confirm(ctx, row.email, userID)
	if err != nil {
		return Status{}, errUnavailable.WithCause(err)
	}
	if !answer.Found || !answer.belongsTo(userID) {
		if _, err := c.env.DB.ExecContext(ctx,
			`DELETE FROM claudex_zecous_migrations WHERE user_id = $1 AND email = $2 AND state = 'confirming'`, userID, row.email); err != nil {
			return Status{}, errUnavailable.WithCause(err)
		}
		return Status{}, errNothing
	}
	if !answer.Migrated {
		return Status{}, errUnavailable.WithCause(errors.New("zmigrate: unconfirmed account move"))
	}
	status, err := answer.valuation("done")
	if err != nil {
		return Status{}, errUnavailable.WithCause(err)
	}
	status, err = c.settle(ctx, userID, row.email, status, answer)
	if err != nil {
		return Status{}, errUnavailable.WithCause(err)
	}
	return status, nil
}

func (c *Component) settle(ctx context.Context, userID int64, email string, status Status, answer Answer) (Status, error) {
	detail, err := json.Marshal(answer)
	if err != nil {
		return Status{}, err
	}
	tx, err := c.env.EntClient.Tx(ctx)
	if err != nil {
		return Status{}, err
	}
	defer func() { _ = tx.Rollback() }()
	row, err := readMigration(ctx, tx.Client(), userID, true)
	if err != nil {
		return Status{}, err
	}
	if row.state == "credited" {
		return row.creditedStatus(), nil
	}
	if row.state != "confirming" || row.email != email {
		return Status{}, errors.New("zmigrate: account move changed before settlement")
	}
	txCtx := dbent.NewTxContext(ctx, tx)
	legacy, err := tx.RedeemCode.Query().Where(
		redeemcode.UsedByEQ(userID),
		redeemcode.TypeEQ(service.AdjustmentTypeAdminBalance),
		redeemcode.NotesHasPrefix(NoteMarker),
	).Order(dbent.Asc(redeemcode.FieldID)).First(txCtx)
	switch {
	case err == nil:
		if legacy.Value != status.AmountUSD {
			status = Status{State: "done", AmountUSD: legacy.Value}
		}
	case !dbent.IsNotFound(err):
		return Status{}, err
	case status.AmountUSD > 0:
		if err := c.env.MigrationBalance.CreditMigrationBalance(txCtx, userID, status.AmountUSD); err != nil {
			return Status{}, err
		}
		code, err := service.GenerateRedeemCode()
		if err != nil {
			return Status{}, err
		}
		now := time.Now()
		notes := fmt.Sprintf("%s total_cny=%s balance_cny=%s subscription_cny=%s",
			NoteMarker, answer.TotalCNY, answer.BalanceCNY, answer.SubscriptionCNY)
		if err := c.env.RedeemCodeRepo.Create(txCtx, &service.RedeemCode{
			Code:   code,
			Type:   service.AdjustmentTypeAdminBalance,
			Value:  status.AmountUSD,
			Status: service.StatusUsed,
			UsedBy: &userID,
			UsedAt: &now,
			Notes:  notes,
		}); err != nil {
			return Status{}, err
		}
	}
	if _, err := tx.Client().ExecContext(ctx,
		`UPDATE claudex_zecous_migrations SET state = 'credited', amount_usd = $2, detail = $3::jsonb, credited_at = NOW()
		 WHERE user_id = $1`, userID, status.AmountUSD, string(detail)); err != nil {
		return Status{}, err
	}
	if err := tx.Commit(); err != nil {
		return Status{}, err
	}
	return status, nil
}

func (c *Component) invalidateBalance(ctx context.Context, userID int64) {
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	defer cancel()
	if c.env.APIKeys != nil {
		c.env.APIKeys.InvalidateAuthCacheByUserID(ctx, userID)
	}
	if c.env.BillingCache != nil {
		_ = c.env.BillingCache.InvalidateUserBalance(ctx, userID)
	}
}

// sshRemote runs zmigrate.py through its SSH key's forced command.
type sshRemote struct {
	target, key, knownHosts string
}

func (r *sshRemote) run(ctx context.Context, args ...string) (Answer, error) {
	ctx, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()
	cmdArgs := []string{"-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-o", "StrictHostKeyChecking=yes"}
	if r.key != "" {
		cmdArgs = append(cmdArgs, "-i", r.key, "-o", "IdentitiesOnly=yes")
	}
	if r.knownHosts != "" {
		cmdArgs = append(cmdArgs, "-o", "UserKnownHostsFile="+r.knownHosts)
	}
	cmdArgs = append(cmdArgs, r.target, strings.Join(args, " "))
	var out, errOut bytes.Buffer
	cmd := exec.CommandContext(ctx, "ssh", cmdArgs...)
	cmd.Stdout, cmd.Stderr = &out, &errOut
	runErr := cmd.Run()
	var answer Answer
	if err := json.Unmarshal(bytes.TrimSpace(out.Bytes()), &answer); err != nil {
		if runErr != nil {
			return Answer{}, fmt.Errorf("zmigrate: %v: %s", runErr, strings.TrimSpace(errOut.String()))
		}
		return Answer{}, fmt.Errorf("zmigrate: unreadable answer: %v", err)
	}
	if !answer.OK {
		return Answer{}, fmt.Errorf("zmigrate: %s", answer.Error)
	}
	return answer, nil
}

func (r *sshRemote) Quote(ctx context.Context, email string) (Answer, error) {
	return r.run(ctx, "quote", email)
}

func (r *sshRemote) Confirm(ctx context.Context, email string, userID int64) (Answer, error) {
	return r.run(ctx, "confirm", email, strconv.FormatInt(userID, 10))
}
