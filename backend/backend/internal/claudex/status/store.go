package status

import (
	"context"
	"database/sql"
	"errors"
	"time"

	"github.com/lib/pq"
)

// store is the persistence the component uses (sqlStore; a memory store in tests).
type store interface {
	// refresh recounts each channel's days since `since` from Sub2API's
	// check history; with keepExisting it only fills days it doesn't have.
	refresh(ctx context.Context, since time.Time, tz string, keepExisting bool) error
	prune(ctx context.Context, before time.Time) error
	channels(ctx context.Context, from time.Time) ([]Channel, error)
	counts(ctx context.Context, from, to time.Time) ([]DayCounts, error)
	// slots counts each channel's checks per `minutes` (a divisor of an
	// hour) from Sub2API's history, from `from` up to `to`; Day is the
	// slot's start in tz.
	slots(ctx context.Context, from, to time.Time, tz string, minutes int) ([]DayCounts, error)
	// latest is each channel's last three check statuses, newest first.
	latest(ctx context.Context, since time.Time) (map[key][]string, error)
	// incidents: the open ones and those resolved or started since `since`, newest first.
	// publishedOnly leaves out the drafts (what people see).
	incidents(ctx context.Context, since time.Time, limit int, publishedOnly bool) ([]Incident, error)
	incident(ctx context.Context, id int64) (*Incident, error)
	create(ctx context.Context, in IncidentInput, auto bool, by int64, now time.Time) (*Incident, error)
	// update changes what the input names; a status or a message adds an update.
	update(ctx context.Context, id int64, in IncidentInput, by int64, now time.Time) (*Incident, error)
	remove(ctx context.Context, id int64) (bool, error)
}

type sqlStore struct{ db *sql.DB }

func (s *sqlStore) refresh(ctx context.Context, since time.Time, tz string, keepExisting bool) error {
	conflict := `DO UPDATE SET total = EXCLUDED.total, operational = EXCLUDED.operational,
		degraded = EXCLUDED.degraded, failed = EXCLUDED.failed, updated_at = NOW()`
	if keepExisting {
		conflict = `DO NOTHING`
	}
	_, err := s.db.ExecContext(ctx, `INSERT INTO claudex_status_days
		(monitor_id, model, day, total, operational, degraded, failed, updated_at)
		SELECT monitor_id, model, (checked_at AT TIME ZONE $2::text)::date, COUNT(*),
			COUNT(*) FILTER (WHERE status = 'operational'),
			COUNT(*) FILTER (WHERE status = 'degraded'),
			COUNT(*) FILTER (WHERE status IN ('failed','error')), NOW()
		FROM channel_monitor_histories WHERE checked_at >= $1::timestamptz
		GROUP BY 1, 2, 3
		ON CONFLICT (monitor_id, model, day) `+conflict, since, tz)
	return err
}

func (s *sqlStore) prune(ctx context.Context, before time.Time) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM claudex_status_days WHERE day < $1::date`, before.Format("2006-01-02"))
	return err
}

// channels lists each enabled monitor's configured models: its primary
// model and its extra ones. A model it checked before but no longer does is
// left out, however recent its history (owner, 2026-10-02: a row showed the
// replaced gpt-6-sol beside gpt-6.1-sol). A monitor whose group names
// another enabled monitor comes right after it (owner, 2026-10-14: "Astra
// 专用" under codex).
func (s *sqlStore) channels(ctx context.Context, _ time.Time) ([]Channel, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT m.id, m.name, m.provider, x.model
		FROM channel_monitors m
		CROSS JOIN LATERAL (
			SELECT m.primary_model AS model
			UNION SELECT jsonb_array_elements_text(
				CASE WHEN jsonb_typeof(m.extra_models) = 'array' THEN m.extra_models ELSE '[]'::jsonb END)
		) x
		WHERE m.enabled AND x.model <> ''
		ORDER BY COALESCE((SELECT MIN(p.id) FROM channel_monitors p
			WHERE p.enabled AND p.id <> m.id AND m.group_name <> '' AND p.name = m.group_name), m.id),
			(m.group_name <> ''), m.id, x.model`)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	var out []Channel
	for rows.Next() {
		var c Channel
		if err := rows.Scan(&c.ID, &c.Name, &c.Platform, &c.Model); err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

func (s *sqlStore) counts(ctx context.Context, from, to time.Time) ([]DayCounts, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT monitor_id, model, day, total, operational, degraded, failed
		FROM claudex_status_days WHERE day BETWEEN $1::date AND $2::date`,
		from.Format("2006-01-02"), to.Format("2006-01-02"))
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	var out []DayCounts
	for rows.Next() {
		var c DayCounts
		if err := rows.Scan(&c.MonitorID, &c.Model, &c.Day, &c.Total, &c.Operational, &c.Degraded, &c.Failed); err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

func (s *sqlStore) slots(ctx context.Context, from, to time.Time, tz string, minutes int) ([]DayCounts, error) {
	loc, err := time.LoadLocation(tz)
	if err != nil {
		return nil, err
	}
	rows, err := s.db.QueryContext(ctx, `SELECT monitor_id, model,
			to_char(date_trunc('hour', checked_at AT TIME ZONE $3::text)
				+ floor(extract(minute FROM checked_at AT TIME ZONE $3::text) / $4::int) * $4::int * interval '1 minute',
				'YYYY-MM-DD"T"HH24:MI'), COUNT(*),
			COUNT(*) FILTER (WHERE status = 'operational'),
			COUNT(*) FILTER (WHERE status = 'degraded'),
			COUNT(*) FILTER (WHERE status IN ('failed','error'))
		FROM channel_monitor_histories
		WHERE checked_at >= $1::timestamptz AND checked_at < $2::timestamptz
		GROUP BY 1, 2, 3`, from, to, tz, minutes)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	var out []DayCounts
	for rows.Next() {
		var c DayCounts
		var slot string
		if err := rows.Scan(&c.MonitorID, &c.Model, &slot, &c.Total, &c.Operational, &c.Degraded, &c.Failed); err != nil {
			return nil, err
		}
		if c.Day, err = time.ParseInLocation("2006-01-02T15:04", slot, loc); err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

func (s *sqlStore) latest(ctx context.Context, since time.Time) (map[key][]string, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT monitor_id, model, status FROM (
		SELECT monitor_id, model, status,
			ROW_NUMBER() OVER (PARTITION BY monitor_id, model ORDER BY checked_at DESC) AS n
		FROM channel_monitor_histories WHERE checked_at >= $1::timestamptz) t
		WHERE n <= 3 ORDER BY monitor_id, model, n`, since)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	out := map[key][]string{}
	for rows.Next() {
		var k key
		var st string
		if err := rows.Scan(&k.monitor, &k.model, &st); err != nil {
			return nil, err
		}
		out[k] = append(out[k], st)
	}
	return out, rows.Err()
}

const incidentColumns = `i.id, i.title, i.platform, i.impact, i.status, i.auto, i.published, i.started_at, i.resolved_at, i.updated_at,
	EXISTS (SELECT 1 FROM claudex_status_incident_updates u WHERE u.incident_id = i.id AND u.created_by <> 0)`

func scanIncident(sc interface{ Scan(...any) error }) (*Incident, error) {
	var in Incident
	var resolved sql.NullTime
	if err := sc.Scan(&in.ID, &in.Title, &in.Platform, &in.Impact, &in.Status, &in.Auto, &in.Published, &in.StartedAt,
		&resolved, &in.UpdatedAt, &in.touched); err != nil {
		return nil, err
	}
	if resolved.Valid {
		t := resolved.Time
		in.ResolvedAt = &t
	}
	in.Updates = []Update{}
	return &in, nil
}

// withUpdates fills each incident's updates (newest first) and message.
func (s *sqlStore) withUpdates(ctx context.Context, list []Incident) error {
	if len(list) == 0 {
		return nil
	}
	ids := make([]int64, len(list))
	at := map[int64]int{}
	for i, in := range list {
		ids[i] = in.ID
		at[in.ID] = i
	}
	rows, err := s.db.QueryContext(ctx, `SELECT incident_id, status, message, created_at
		FROM claudex_status_incident_updates WHERE incident_id = ANY($1::bigint[]) ORDER BY created_at DESC, id DESC`, pq.Array(ids))
	if err != nil {
		return err
	}
	defer func() { _ = rows.Close() }()
	for rows.Next() {
		var id int64
		var u Update
		if err := rows.Scan(&id, &u.Status, &u.Message, &u.CreatedAt); err != nil {
			return err
		}
		in := &list[at[id]]
		if len(in.Updates) == 0 {
			in.Message = u.Message
		}
		in.Updates = append(in.Updates, u)
	}
	return rows.Err()
}

func (s *sqlStore) incidents(ctx context.Context, since time.Time, limit int, publishedOnly bool) ([]Incident, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT `+incidentColumns+` FROM claudex_status_incidents i
		WHERE (i.resolved_at IS NULL OR i.resolved_at >= $1::timestamptz OR i.started_at >= $1::timestamptz)
			AND (i.published OR NOT $3::bool)
		ORDER BY i.started_at DESC, i.id DESC LIMIT $2::int`, since, limit, publishedOnly)
	if err != nil {
		return nil, err
	}
	var out []Incident
	for rows.Next() {
		in, err := scanIncident(rows)
		if err != nil {
			_ = rows.Close()
			return nil, err
		}
		out = append(out, *in)
	}
	_ = rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return out, s.withUpdates(ctx, out)
}

func (s *sqlStore) incident(ctx context.Context, id int64) (*Incident, error) {
	in, err := scanIncident(s.db.QueryRowContext(ctx, `SELECT `+incidentColumns+` FROM claudex_status_incidents i WHERE i.id = $1::bigint`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	list := []Incident{*in}
	if err := s.withUpdates(ctx, list); err != nil {
		return nil, err
	}
	return &list[0], nil
}

func (s *sqlStore) create(ctx context.Context, in IncidentInput, auto bool, by int64, now time.Time) (*Incident, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback() }()
	var resolved any
	if in.Status == StatusResolved {
		resolved = now
	}
	var id int64
	if err := tx.QueryRowContext(ctx, `INSERT INTO claudex_status_incidents
		(title, platform, impact, status, auto, published, started_at, resolved_at, created_by, created_at, updated_at)
		VALUES ($1::text,$2::text,$3::text,$4::text,$5::bool,$9::bool,$6::timestamptz,$7::timestamptz,$8::bigint,$6::timestamptz,$6::timestamptz) RETURNING id`,
		in.Title, in.Platform, in.Impact, in.Status, auto, now, resolved, by, in.Published == nil || *in.Published).Scan(&id); err != nil {
		return nil, err
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO claudex_status_incident_updates
		(incident_id, status, message, created_by, created_at) VALUES ($1::bigint,$2::text,$3::text,$4::bigint,$5::timestamptz)`,
		id, in.Status, in.Message, by, now); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return s.incident(ctx, id)
}

func (s *sqlStore) update(ctx context.Context, id int64, in IncidentInput, by int64, now time.Time) (*Incident, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback() }()
	var status string
	err = tx.QueryRowContext(ctx, `UPDATE claudex_status_incidents SET
		title = COALESCE(NULLIF($2::text,''), title),
		platform = CASE WHEN $3::text = '-' THEN platform ELSE $3::text END,
		impact = COALESCE(NULLIF($4::text,''), impact),
		status = COALESCE(NULLIF($5::text,''), status),
		published = COALESCE($7::bool, published),
		resolved_at = CASE WHEN $5::text = '' THEN resolved_at WHEN $5::text = 'resolved' THEN COALESCE(resolved_at, $6::timestamptz) ELSE NULL END,
		updated_at = $6::timestamptz
		WHERE id = $1::bigint RETURNING status`, id, in.Title, in.Platform, in.Impact, in.Status, now, in.Published).Scan(&status)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if in.Status != "" || in.Message != "" {
		if _, err := tx.ExecContext(ctx, `INSERT INTO claudex_status_incident_updates
			(incident_id, status, message, created_by, created_at) VALUES ($1::bigint,$2::text,$3::text,$4::bigint,$5::timestamptz)`,
			id, status, in.Message, by, now); err != nil {
			return nil, err
		}
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return s.incident(ctx, id)
}

func (s *sqlStore) remove(ctx context.Context, id int64) (bool, error) {
	res, err := s.db.ExecContext(ctx, `DELETE FROM claudex_status_incidents WHERE id = $1::bigint`, id)
	if err != nil {
		return false, err
	}
	n, _ := res.RowsAffected()
	return n > 0, nil
}
