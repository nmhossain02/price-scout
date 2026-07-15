package store

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/nmhossain02/price-scout/internal/domain"
)

type CreateMonitorParams struct {
	URL             string
	Intent          string
	IntervalMinutes int
	Traceparent     string
}

func (s *Store) CreateMonitor(ctx context.Context, params CreateMonitorParams) (domain.Monitor, domain.Execution, error) {
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{})
	if err != nil {
		return domain.Monitor{}, domain.Execution{}, err
	}
	defer tx.Rollback(ctx)

	monitorID := uuid.New()
	executionID := uuid.New()
	input, _ := json.Marshal(map[string]any{"url": params.URL, "intent": params.Intent})
	_, err = tx.Exec(ctx, `INSERT INTO monitors
        (id, url, intent, interval_minutes, status)
        VALUES ($1,$2,$3,$4,'compiling')`, monitorID, params.URL, params.Intent, params.IntervalMinutes)
	if err != nil {
		return domain.Monitor{}, domain.Execution{}, fmt.Errorf("insert monitor: %w", err)
	}
	_, err = tx.Exec(ctx, `INSERT INTO executions
        (id, monitor_id, kind, state, input) VALUES ($1,$2,'compile','queued',$3)`,
		executionID, monitorID, input)
	if err != nil {
		return domain.Monitor{}, domain.Execution{}, fmt.Errorf("insert compile execution: %w", err)
	}
	message := domain.WorkMessage{SchemaVersion: domain.SchemaVersion, ExecutionID: executionID, MonitorID: monitorID, Traceparent: params.Traceparent}
	if err := insertOutbox(ctx, tx, "scout.monitor.compile", message); err != nil {
		return domain.Monitor{}, domain.Execution{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return domain.Monitor{}, domain.Execution{}, err
	}
	monitor, err := s.GetMonitor(ctx, monitorID)
	if err != nil {
		return domain.Monitor{}, domain.Execution{}, err
	}
	execution, err := s.GetExecution(ctx, executionID)
	return monitor, execution, err
}

func (s *Store) GetMonitor(ctx context.Context, id uuid.UUID) (domain.Monitor, error) {
	monitor, err := scanMonitor(s.pool.QueryRow(ctx, `SELECT `+monitorColumns+` FROM monitors WHERE id=$1`, id))
	return monitor, translateError(err)
}

func (s *Store) ListMonitors(ctx context.Context, limit, offset int) ([]domain.MonitorSummary, error) {
	rows, err := s.pool.Query(ctx, `SELECT `+qualifiedMonitorColumns+`,
        CASE WHEN latest.id IS NULL THEN NULL ELSE jsonb_build_object(
            'id', latest.id,
            'monitorId', latest.monitor_id,
            'executionId', latest.execution_id,
            'priceMinor', latest.price_minor,
            'currency', latest.currency,
            'inStock', latest.in_stock,
            'title', latest.title,
            'rawText', latest.raw_text,
            'identity', latest.identity,
            'verificationState', latest.verification_state,
            'conditionMatched', latest.condition_matched,
            'observedAt', latest.observed_at
        ) END AS latest_observation
    FROM monitors m
    LEFT JOIN LATERAL (
        SELECT o.id, o.monitor_id, o.execution_id, o.price_minor, o.currency,
            o.in_stock, o.title, o.raw_text, o.identity, o.verification_state,
            o.condition_matched, o.observed_at
        FROM observations o
        WHERE o.monitor_id=m.id
        ORDER BY o.observed_at DESC, o.id DESC
        LIMIT 1
    ) latest ON true
    ORDER BY m.created_at DESC LIMIT $1 OFFSET $2`, limit, offset)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := make([]domain.MonitorSummary, 0)
	for rows.Next() {
		item, err := scanMonitorSummary(rows)
		if err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func (s *Store) GetMonitorDetail(ctx context.Context, id uuid.UUID) (domain.MonitorDetail, error) {
	monitor, err := s.GetMonitor(ctx, id)
	if err != nil {
		return domain.MonitorDetail{}, err
	}
	detail := domain.MonitorDetail{Monitor: monitor, Revisions: []domain.Revision{}, Executions: []domain.Execution{}, Observations: []domain.Observation{}}

	revisionRows, err := s.pool.Query(ctx, `SELECT `+revisionColumns+` FROM monitor_revisions WHERE monitor_id=$1 ORDER BY generation DESC`, id)
	if err != nil {
		return domain.MonitorDetail{}, err
	}
	for revisionRows.Next() {
		revision, scanErr := scanRevision(revisionRows)
		if scanErr != nil {
			revisionRows.Close()
			return domain.MonitorDetail{}, scanErr
		}
		detail.Revisions = append(detail.Revisions, revision)
	}
	revisionRows.Close()
	if err := revisionRows.Err(); err != nil {
		return domain.MonitorDetail{}, err
	}

	executionRows, err := s.pool.Query(ctx, `SELECT `+executionColumns+` FROM executions WHERE monitor_id=$1 ORDER BY created_at DESC LIMIT 100`, id)
	if err != nil {
		return domain.MonitorDetail{}, err
	}
	for executionRows.Next() {
		execution, scanErr := scanExecution(executionRows)
		if scanErr != nil {
			executionRows.Close()
			return domain.MonitorDetail{}, scanErr
		}
		detail.Executions = append(detail.Executions, execution)
	}
	executionRows.Close()
	if err := executionRows.Err(); err != nil {
		return domain.MonitorDetail{}, err
	}

	observationRows, err := s.pool.Query(ctx, `SELECT `+observationColumns+` FROM observations WHERE monitor_id=$1 ORDER BY observed_at DESC LIMIT 500`, id)
	if err != nil {
		return domain.MonitorDetail{}, err
	}
	for observationRows.Next() {
		observation, scanErr := scanObservation(observationRows)
		if scanErr != nil {
			observationRows.Close()
			return domain.MonitorDetail{}, scanErr
		}
		detail.Observations = append(detail.Observations, observation)
	}
	observationRows.Close()
	return detail, observationRows.Err()
}

type ConfirmMonitorParams struct {
	RevisionID uuid.UUID
	Condition  json.RawMessage
}

func (s *Store) ConfirmMonitor(ctx context.Context, monitorID uuid.UUID, params ConfirmMonitorParams) (domain.Monitor, error) {
	if len(params.Condition) == 0 {
		params.Condition = json.RawMessage(`{}`)
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return domain.Monitor{}, err
	}
	defer tx.Rollback(ctx)
	command, err := tx.Exec(ctx, `UPDATE monitor_revisions SET validation_state='active', activated_at=now()
        WHERE id=$1 AND monitor_id=$2 AND validation_state IN ('candidate','awaiting_confirmation')`, params.RevisionID, monitorID)
	if err != nil {
		return domain.Monitor{}, err
	}
	if command.RowsAffected() == 0 {
		return domain.Monitor{}, ErrConflict
	}
	_, err = tx.Exec(ctx, `UPDATE monitor_revisions SET validation_state='rejected'
        WHERE monitor_id=$1 AND id<>$2 AND validation_state IN ('candidate','awaiting_confirmation')`, monitorID, params.RevisionID)
	if err != nil {
		return domain.Monitor{}, err
	}
	command, err = tx.Exec(ctx, `UPDATE monitors SET current_revision_id=$2, condition=$3, status='active',
		next_run_at=now() + make_interval(mins => interval_minutes), updated_at=now()
		WHERE id=$1`, monitorID, params.RevisionID, params.Condition)
	if err != nil {
		return domain.Monitor{}, err
	}
	if command.RowsAffected() == 0 {
		return domain.Monitor{}, ErrNotFound
	}
	if err := tx.Commit(ctx); err != nil {
		return domain.Monitor{}, err
	}
	return s.GetMonitor(ctx, monitorID)
}

type PatchMonitorParams struct {
	IntervalMinutes *int
	Condition       json.RawMessage
	Action          string
}

func (s *Store) PatchMonitor(ctx context.Context, id uuid.UUID, params PatchMonitorParams) (domain.Monitor, error) {
	sets := []string{"updated_at=now()"}
	args := []any{id}
	if params.IntervalMinutes != nil {
		args = append(args, *params.IntervalMinutes)
		sets = append(sets, fmt.Sprintf("interval_minutes=$%d", len(args)))
	}
	if len(params.Condition) > 0 {
		args = append(args, params.Condition)
		sets = append(sets, fmt.Sprintf("condition=$%d", len(args)))
	}
	switch params.Action {
	case "pause":
		sets = append(sets, "status='paused'", "next_run_at=NULL")
	case "resume":
		sets = append(sets, "status='active'", "next_run_at=now()")
	case "":
	default:
		return domain.Monitor{}, fmt.Errorf("unsupported action %q", params.Action)
	}
	command, err := s.pool.Exec(ctx, `UPDATE monitors SET `+strings.Join(sets, ", ")+` WHERE id=$1`, args...)
	if err != nil {
		return domain.Monitor{}, err
	}
	if command.RowsAffected() == 0 {
		return domain.Monitor{}, ErrNotFound
	}
	return s.GetMonitor(ctx, id)
}

func (s *Store) ReviewRevision(ctx context.Context, monitorID, revisionID uuid.UUID, accept bool) (domain.Monitor, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return domain.Monitor{}, err
	}
	defer tx.Rollback(ctx)
	state := "rejected"
	if accept {
		state = "active"
	}
	command, err := tx.Exec(ctx, `UPDATE monitor_revisions SET validation_state=$3,
        activated_at=CASE WHEN $3='active' THEN now() ELSE activated_at END
        WHERE id=$1 AND monitor_id=$2 AND validation_state IN ('candidate','awaiting_confirmation')`, revisionID, monitorID, state)
	if err != nil {
		return domain.Monitor{}, err
	}
	if command.RowsAffected() == 0 {
		return domain.Monitor{}, ErrConflict
	}
	if accept {
		_, err = tx.Exec(ctx, `UPDATE monitors SET current_revision_id=$2, status='active',
			next_run_at=now() + make_interval(mins => interval_minutes), updated_at=now()
			WHERE id=$1`, monitorID, revisionID)
	} else {
		_, err = tx.Exec(ctx, `UPDATE monitors SET status=CASE WHEN current_revision_id IS NULL THEN 'blocked' ELSE 'active' END, updated_at=now() WHERE id=$1`, monitorID)
	}
	if err != nil {
		return domain.Monitor{}, err
	}
	_, _ = tx.Exec(ctx, `UPDATE repair_attempts SET state=$3, candidate_revision_id=$2, completed_at=now()
        WHERE monitor_id=$1 AND candidate_revision_id=$2`, monitorID, revisionID, map[bool]string{true: "activated", false: "rejected"}[accept])
	if err := tx.Commit(ctx); err != nil {
		return domain.Monitor{}, err
	}
	return s.GetMonitor(ctx, monitorID)
}

func (s *Store) ClaimDueMonitors(ctx context.Context, limit int) (int, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback(ctx)
	rows, err := tx.Query(ctx, `SELECT id, current_revision_id FROM monitors
        WHERE status='active' AND current_revision_id IS NOT NULL AND next_run_at <= now()
        AND NOT EXISTS (SELECT 1 FROM executions e WHERE e.monitor_id=monitors.id AND e.state IN ('queued','running'))
        ORDER BY next_run_at FOR UPDATE SKIP LOCKED LIMIT $1`, limit)
	if err != nil {
		return 0, err
	}
	type due struct{ monitorID, revisionID uuid.UUID }
	items := make([]due, 0)
	for rows.Next() {
		var item due
		if err := rows.Scan(&item.monitorID, &item.revisionID); err != nil {
			rows.Close()
			return 0, err
		}
		items = append(items, item)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return 0, err
	}
	for _, item := range items {
		executionID := uuid.New()
		var generation int
		if err := tx.QueryRow(ctx, `SELECT generation FROM monitor_revisions WHERE id=$1`, item.revisionID).Scan(&generation); err != nil {
			return 0, err
		}
		_, err := tx.Exec(ctx, `INSERT INTO executions
            (id, monitor_id, revision_id, kind, requested_generation, state)
            VALUES ($1,$2,$3,'check',$4,'queued')`, executionID, item.monitorID, item.revisionID, generation)
		if err != nil {
			return 0, err
		}
		message := domain.WorkMessage{SchemaVersion: domain.SchemaVersion, ExecutionID: executionID, MonitorID: item.monitorID, RevisionID: &item.revisionID}
		if err := insertOutbox(ctx, tx, "scout.monitor.check", message); err != nil {
			return 0, err
		}
		_, err = tx.Exec(ctx, `UPDATE monitors SET next_run_at=now() + make_interval(mins => interval_minutes), updated_at=now() WHERE id=$1`, item.monitorID)
		if err != nil {
			return 0, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, err
	}
	return len(items), nil
}
