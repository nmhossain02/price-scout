package store

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/nmhossain02/price-scout/internal/domain"
)

type OutboxMessage struct {
	ID      int64
	Subject string
	Payload []byte
}

func insertOutbox(ctx context.Context, tx pgx.Tx, subject string, message domain.WorkMessage) error {
	payload, err := json.Marshal(message)
	if err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `INSERT INTO outbox (subject, payload) VALUES ($1,$2)`, subject, payload)
	if err != nil {
		return fmt.Errorf("insert outbox message: %w", err)
	}
	return nil
}

// ProcessOutbox publishes a bounded batch transactionally. JetStream receives
// the outbox ID as its deduplication ID, which suppresses relay duplicates
// inside the stream's deduplication window. Consumers still treat delivery as
// at-least-once and the result boundary remains idempotent.
func (s *Store) ProcessOutbox(ctx context.Context, limit int, publish func(context.Context, OutboxMessage) error) (int, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback(ctx)
	rows, err := tx.Query(ctx, `SELECT id, subject, payload FROM outbox
        WHERE published_at IS NULL ORDER BY id FOR UPDATE SKIP LOCKED LIMIT $1`, limit)
	if err != nil {
		return 0, err
	}
	messages := make([]OutboxMessage, 0)
	for rows.Next() {
		var message OutboxMessage
		if err := rows.Scan(&message.ID, &message.Subject, &message.Payload); err != nil {
			rows.Close()
			return 0, err
		}
		messages = append(messages, message)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return 0, err
	}
	for _, message := range messages {
		if err := publish(ctx, message); err != nil {
			_, _ = tx.Exec(ctx, `UPDATE outbox SET attempts=attempts+1, last_error=$2 WHERE id=$1`, message.ID, err.Error())
			if commitErr := tx.Commit(ctx); commitErr != nil {
				return 0, commitErr
			}
			return 0, err
		}
		_, err := tx.Exec(ctx, `UPDATE outbox SET published_at=now(), attempts=attempts+1, last_error=NULL WHERE id=$1`, message.ID)
		if err != nil {
			return 0, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, err
	}
	return len(messages), nil
}
