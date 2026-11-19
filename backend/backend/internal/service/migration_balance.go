package service

import "context"

type MigrationBalanceRepository interface {
	CreditMigrationBalance(ctx context.Context, id int64, amount float64) error
}
