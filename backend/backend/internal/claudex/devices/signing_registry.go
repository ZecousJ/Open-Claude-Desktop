package devices

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strconv"
	"time"

	infraerrors "github.com/Wei-Shaw/sub2api/internal/pkg/errors"
	"github.com/google/uuid"
)

type signingDevice struct {
	ID               string     `json:"id"`
	DeviceID         string     `json:"device_id"`
	DisplayName      string     `json:"display_name"`
	Platform         string     `json:"platform"`
	PublicKey        []byte     `json:"public_key"`
	IsHardwareBacked bool       `json:"is_hardware_backed"`
	RevokedAt        *time.Time `json:"revoked_at,omitempty"`
	CreatedAt        time.Time  `json:"created_at"`
	UpdatedAt        time.Time  `json:"updated_at"`
}

type signingDeviceRegistration struct {
	DeviceID         string
	DisplayName      string
	Platform         string
	PublicKey        []byte
	IsHardwareBacked bool
}

const signingDeviceColumns = `id, device_id, display_name, platform, public_key, is_hardware_backed,
	revoked_at, created_at, updated_at`

var (
	errSigningDeviceNotFound = infraerrors.NotFound("cowork_remote_device_not_found", "Signing device not found.")
	errSigningDeviceMismatch = infraerrors.Conflict("cowork_remote_device_key_mismatch", "This installation is registered to a different signing key.")
	errSigningDeviceRevoked  = infraerrors.Conflict("cowork_remote_device_registration_revoked", "This signing key has been revoked.")
	errSigningDeviceKeyed    = infraerrors.Conflict("cowork_remote_device_keyed", "This device already has a signing key.")

	errSigningRegistryUnavailable = infraerrors.ServiceUnavailable("CLAUDEX_SIGNING_DEVICES_UNAVAILABLE", "The signing-device registry is temporarily unavailable.")
)

func scanSigningDevice(s rowScanner) (*signingDevice, error) {
	var d signingDevice
	var revoked sql.NullTime
	err := s.Scan(&d.ID, &d.DeviceID, &d.DisplayName, &d.Platform, &d.PublicKey, &d.IsHardwareBacked,
		&revoked, &d.CreatedAt, &d.UpdatedAt)
	if err != nil {
		return nil, err
	}
	d.RevokedAt = nullTime(revoked)
	d.CreatedAt = d.CreatedAt.UTC()
	d.UpdatedAt = d.UpdatedAt.UTC()
	return &d, nil
}

func (c *Component) listSigningDevices(ctx context.Context, userID int64) ([]signingDevice, error) {
	rows, err := c.env.DB.QueryContext(ctx, `SELECT `+signingDeviceColumns+`
FROM claudex_signing_devices WHERE user_id = $1 AND revoked_at IS NULL ORDER BY created_at, id`, userID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	devices := make([]signingDevice, 0)
	for rows.Next() {
		d, err := scanSigningDevice(rows)
		if err != nil {
			return nil, err
		}
		devices = append(devices, *d)
	}
	return devices, rows.Err()
}

func (c *Component) registerSigningDevice(ctx context.Context, userID int64, in signingDeviceRegistration) (*signingDevice, error) {
	settings := c.settings(ctx)
	var registered *signingDevice
	err := c.withSigningDeviceLock(ctx, userID, func(tx *sql.Tx) error {
		d, err := c.upsertSigningDevice(ctx, tx, userID, settings, in)
		registered = d
		return err
	})
	return registered, err
}

func (c *Component) upsertSigningDevice(ctx context.Context, tx *sql.Tx, userID int64, settings Provisioning, in signingDeviceRegistration) (*signingDevice, error) {
	if in.PublicKey != nil {
		matchingKey, err := scanSigningDevice(tx.QueryRowContext(ctx, `SELECT `+signingDeviceColumns+`
FROM claudex_signing_devices WHERE user_id = $1 AND public_key = $2`, userID, in.PublicKey))
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			return nil, err
		}
		if matchingKey != nil {
			if matchingKey.RevokedAt != nil {
				return nil, errSigningDeviceRevoked
			}
			return matchingKey, nil
		}
	}
	if in.DeviceID != "" {
		current, err := scanSigningDevice(tx.QueryRowContext(ctx, `SELECT `+signingDeviceColumns+`
FROM claudex_signing_devices WHERE user_id = $1 AND device_id = $2 AND revoked_at IS NULL`, userID, in.DeviceID))
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			return nil, err
		}
		if in.PublicKey == nil {
			switch {
			case current == nil:
				return nil, errSigningDeviceNotFound
			case current.PublicKey != nil:
				return nil, errSigningDeviceKeyed
			default:
				return current, nil
			}
		}
		if current != nil {
			if current.PublicKey != nil {
				return nil, errSigningDeviceMismatch
			}
			return scanSigningDevice(tx.QueryRowContext(ctx, `UPDATE claudex_signing_devices
SET public_key = $3, is_hardware_backed = $4, platform = $5, updated_at = NOW()
WHERE user_id = $1 AND id = $2 RETURNING `+signingDeviceColumns,
				userID, current.ID, in.PublicKey, in.IsHardwareBacked, in.Platform))
		}
	}

	limit, _, err := c.effectiveLimit(ctx, tx, userID, settings)
	if err != nil {
		return nil, err
	}
	var active int
	if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM claudex_signing_devices
WHERE user_id = $1 AND revoked_at IS NULL`, userID).Scan(&active); err != nil {
		return nil, err
	}
	if active >= limit {
		return nil, infraerrors.BadRequest("cowork_remote_device_limit_reached", fmt.Sprintf("Your account allows up to %d signing devices.", limit)).
			WithMetadata(map[string]string{"limit": strconv.Itoa(limit), "active": strconv.Itoa(active)})
	}
	if in.DeviceID == "" {
		in.DeviceID = uuid.NewString()
	}
	var publicKey any
	if in.PublicKey != nil {
		publicKey = in.PublicKey
	}
	return scanSigningDevice(tx.QueryRowContext(ctx, `INSERT INTO claudex_signing_devices
(user_id, device_id, display_name, platform, public_key, is_hardware_backed) VALUES ($1, $2, $3, $4, $5, $6)
RETURNING `+signingDeviceColumns, userID, in.DeviceID, in.DisplayName, in.Platform, publicKey, in.IsHardwareBacked))
}

func (c *Component) renameSigningDevice(ctx context.Context, userID int64, id, name string) (*signingDevice, error) {
	d, err := scanSigningDevice(c.env.DB.QueryRowContext(ctx, `UPDATE claudex_signing_devices
SET display_name = $3::varchar, updated_at = CASE WHEN display_name = $3::varchar THEN updated_at ELSE NOW() END
WHERE user_id = $1 AND id = $2 AND revoked_at IS NULL RETURNING `+signingDeviceColumns, userID, id, name))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, errSigningDeviceNotFound
	}
	return d, err
}

func (c *Component) revokeSigningDevice(ctx context.Context, userID int64, id string) error {
	return c.withSigningDeviceLock(ctx, userID, func(tx *sql.Tx) error {
		res, err := tx.ExecContext(ctx, `UPDATE claudex_signing_devices
SET revoked_at = COALESCE(revoked_at, NOW()), updated_at = CASE WHEN revoked_at IS NULL THEN NOW() ELSE updated_at END
WHERE user_id = $1 AND id = $2`, userID, id)
		if err != nil {
			return err
		}
		if count, err := res.RowsAffected(); err != nil {
			return err
		} else if count == 0 {
			return errSigningDeviceNotFound
		}
		return nil
	})
}

func (c *Component) withSigningDeviceLock(ctx context.Context, userID int64, write func(*sql.Tx) error) error {
	tx, err := c.env.DB.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	if err := lockUser(ctx, tx, userID); err != nil {
		return err
	}
	if err := write(tx); err != nil {
		return err
	}
	return tx.Commit()
}
