package store

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

type AlertDelivery struct {
	ID              uuid.UUID
	AlertID         uuid.UUID
	Channel         string
	Attempt         int
	AlertCreatedAt  time.Time
	MonitorID       uuid.UUID
	MonitorURL      string
	MonitorIntent   string
	ObservationID   uuid.UUID
	ExecutionID     uuid.UUID
	PriceMinor      int64
	Currency        string
	InStock         bool
	Title           string
	ObservationTime time.Time
}

func (s *Store) createAlert(ctx context.Context, tx pgx.Tx, monitorID, observationID uuid.UUID, idempotencyKey string) error {
	alertID := uuid.New()
	deliveryState := "unconfigured"
	if len(s.alertChannels) > 0 {
		deliveryState = "pending"
	}
	if _, err := tx.Exec(ctx, `INSERT INTO alerts
        (id, monitor_id, observation_id, channel, idempotency_key, delivery_state)
        VALUES ($1,$2,$3,'configured',$4,$5)`, alertID, monitorID, observationID, idempotencyKey, deliveryState); err != nil {
		return err
	}
	for _, channel := range s.alertChannels {
		if _, err := tx.Exec(ctx, `INSERT INTO alert_deliveries
            (id, alert_id, channel) VALUES ($1,$2,$3)
            ON CONFLICT (alert_id, channel) DO NOTHING`, uuid.New(), alertID, channel); err != nil {
			return err
		}
	}
	return nil
}

// ReconcileAlertDeliveries backfills alerts created before the delivery table
// existed and permanently closes pending channels removed from configuration.
func (s *Store) ReconcileAlertDeliveries(ctx context.Context) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	rows, err := tx.Query(ctx, `SELECT a.id FROM alerts a
        WHERE a.delivery_state IN ('pending','unconfigured')
        AND NOT EXISTS (SELECT 1 FROM alert_deliveries d WHERE d.alert_id=a.id)
        ORDER BY a.created_at FOR UPDATE SKIP LOCKED LIMIT 500`)
	if err != nil {
		return err
	}
	alertIDs := make([]uuid.UUID, 0)
	for rows.Next() {
		var id uuid.UUID
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return err
		}
		alertIDs = append(alertIDs, id)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	for _, alertID := range alertIDs {
		if len(s.alertChannels) == 0 {
			if _, err := tx.Exec(ctx, `UPDATE alerts SET delivery_state='unconfigured' WHERE id=$1`, alertID); err != nil {
				return err
			}
			continue
		}
		for _, channel := range s.alertChannels {
			if _, err := tx.Exec(ctx, `INSERT INTO alert_deliveries (id, alert_id, channel)
                VALUES ($1,$2,$3) ON CONFLICT (alert_id, channel) DO NOTHING`, uuid.New(), alertID, channel); err != nil {
				return err
			}
		}
		if _, err := tx.Exec(ctx, `UPDATE alerts SET delivery_state='pending' WHERE id=$1`, alertID); err != nil {
			return err
		}
	}
	if len(s.alertChannels) == 0 {
		_, err = tx.Exec(ctx, `UPDATE alert_deliveries SET state='failed', lease_owner=NULL,
            lease_expires_at=NULL, last_error='delivery channel is no longer configured', updated_at=now()
            WHERE state='pending' OR (state='leased' AND lease_expires_at <= now())`)
	} else {
		_, err = tx.Exec(ctx, `UPDATE alert_deliveries SET state='failed', lease_owner=NULL,
            lease_expires_at=NULL, last_error='delivery channel is no longer configured', updated_at=now()
            WHERE (state='pending' OR (state='leased' AND lease_expires_at <= now()))
            AND NOT (channel = ANY($1::text[]))`, s.alertChannels)
	}
	if err != nil {
		return err
	}
	if err := refreshAllAlertStates(ctx, tx); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (s *Store) ClaimAlertDeliveries(ctx context.Context, owner uuid.UUID, lease time.Duration, limit int) ([]AlertDelivery, error) {
	if len(s.alertChannels) == 0 {
		return []AlertDelivery{}, nil
	}
	leaseSeconds := max(int(lease/time.Second), 1)
	rows, err := s.pool.Query(ctx, `WITH picked AS (
        SELECT id FROM alert_deliveries
        WHERE channel = ANY($1::text[]) AND (
            (state='pending' AND next_attempt_at <= now()) OR
            (state='leased' AND lease_expires_at <= now())
        )
        ORDER BY next_attempt_at, id
        FOR UPDATE SKIP LOCKED LIMIT $2
    ), claimed AS (
        UPDATE alert_deliveries d SET state='leased', attempts=d.attempts+1,
            lease_owner=$3, lease_expires_at=now()+make_interval(secs => $4), updated_at=now()
        FROM picked WHERE d.id=picked.id
        RETURNING d.id, d.alert_id, d.channel, d.attempts
    )
    SELECT c.id, c.alert_id, c.channel, c.attempts, a.created_at,
        m.id, m.url, m.intent, o.id, o.execution_id, o.price_minor, o.currency,
        o.in_stock, o.title, o.observed_at
    FROM claimed c
    JOIN alerts a ON a.id=c.alert_id
    JOIN monitors m ON m.id=a.monitor_id
    JOIN observations o ON o.id=a.observation_id
    ORDER BY c.id`, s.alertChannels, limit, owner, leaseSeconds)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	deliveries := make([]AlertDelivery, 0)
	for rows.Next() {
		var delivery AlertDelivery
		if err := rows.Scan(&delivery.ID, &delivery.AlertID, &delivery.Channel, &delivery.Attempt,
			&delivery.AlertCreatedAt, &delivery.MonitorID, &delivery.MonitorURL, &delivery.MonitorIntent,
			&delivery.ObservationID, &delivery.ExecutionID, &delivery.PriceMinor, &delivery.Currency,
			&delivery.InStock, &delivery.Title, &delivery.ObservationTime); err != nil {
			return nil, err
		}
		deliveries = append(deliveries, delivery)
	}
	return deliveries, rows.Err()
}

func (s *Store) CompleteAlertDelivery(ctx context.Context, deliveryID, owner uuid.UUID) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var alertID uuid.UUID
	err = tx.QueryRow(ctx, `UPDATE alert_deliveries SET state='delivered', delivered_at=now(),
        lease_owner=NULL, lease_expires_at=NULL, last_error=NULL, updated_at=now()
        WHERE id=$1 AND state='leased' AND lease_owner=$2 RETURNING alert_id`, deliveryID, owner).Scan(&alertID)
	if err != nil {
		return translateError(err)
	}
	if err := refreshAlertState(ctx, tx, alertID); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (s *Store) FailAlertDelivery(ctx context.Context, deliveryID, owner uuid.UUID, attempt, maxAttempts int, nextAttempt time.Time, statusCode int, message string, permanent bool) (string, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return "", err
	}
	defer tx.Rollback(ctx)
	state := "pending"
	if permanent || attempt >= maxAttempts {
		state = "failed"
	}
	message = strings.TrimSpace(message)
	if len(message) > 1000 {
		message = message[:1000]
	}
	var alertID uuid.UUID
	err = tx.QueryRow(ctx, `UPDATE alert_deliveries SET state=$3, next_attempt_at=$4,
        lease_owner=NULL, lease_expires_at=NULL, last_status_code=NULLIF($5,0),
        last_error=NULLIF($6,''), updated_at=now()
        WHERE id=$1 AND state='leased' AND lease_owner=$2 RETURNING alert_id`,
		deliveryID, owner, state, nextAttempt, statusCode, message).Scan(&alertID)
	if err != nil {
		return "", translateError(err)
	}
	if err := refreshAlertState(ctx, tx, alertID); err != nil {
		return "", err
	}
	if err := tx.Commit(ctx); err != nil {
		return "", err
	}
	return state, nil
}

func refreshAlertState(ctx context.Context, tx pgx.Tx, alertID uuid.UUID) error {
	_, err := tx.Exec(ctx, `UPDATE alerts a SET
        delivery_state=CASE
            WHEN stats.pending > 0 THEN 'pending'
            WHEN stats.failed > 0 THEN 'failed'
            ELSE 'delivered'
        END,
        delivered_at=CASE WHEN stats.pending=0 AND stats.failed=0 THEN stats.delivered_at ELSE NULL END
    FROM (
        SELECT alert_id,
            count(*) FILTER (WHERE state IN ('pending','leased')) AS pending,
            count(*) FILTER (WHERE state='failed') AS failed,
            max(delivered_at) AS delivered_at
        FROM alert_deliveries WHERE alert_id=$1 GROUP BY alert_id
    ) stats WHERE a.id=stats.alert_id`, alertID)
	return err
}

func refreshAllAlertStates(ctx context.Context, tx pgx.Tx) error {
	_, err := tx.Exec(ctx, `UPDATE alerts a SET
        delivery_state=CASE
            WHEN stats.pending > 0 THEN 'pending'
            WHEN stats.failed > 0 THEN 'failed'
            ELSE 'delivered'
        END,
        delivered_at=CASE WHEN stats.pending=0 AND stats.failed=0 THEN stats.delivered_at ELSE NULL END
    FROM (
        SELECT alert_id,
            count(*) FILTER (WHERE state IN ('pending','leased')) AS pending,
            count(*) FILTER (WHERE state='failed') AS failed,
            max(delivered_at) AS delivered_at
        FROM alert_deliveries GROUP BY alert_id
    ) stats WHERE a.id=stats.alert_id`)
	return err
}

func (delivery AlertDelivery) String() string {
	return fmt.Sprintf("%s/%s", delivery.Channel, delivery.ID)
}
