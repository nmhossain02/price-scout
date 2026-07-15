package store

import (
	"context"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/nmhossain02/price-scout/internal/domain"
)

const (
	RecoveryRequeued = "requeued"
	RecoveryTerminal = "terminal"
)

type ExecutionRecovery struct {
	ExecutionID   uuid.UUID
	ReplacementID *uuid.UUID
	Kind          domain.ExecutionKind
	PriorState    string
	Outcome       string
	Attempt       int
}

// SweepStaleExecutions makes stale work terminal before optionally creating a
// replacement execution. A new execution ID is deliberate: a late result from
// the abandoned worker remains an idempotent no-op and cannot win a race with
// the replacement attempt.
func (s *Store) SweepStaleExecutions(ctx context.Context, runningStaleAfter time.Duration, maxAttempts, limit int) ([]ExecutionRecovery, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	rows, err := tx.Query(ctx, `SELECT `+executionColumns+` FROM executions
		WHERE state='running' AND started_at < now()-make_interval(secs => $1)
		AND NOT EXISTS (SELECT 1 FROM executions child WHERE child.recovery_of=executions.id)
		ORDER BY COALESCE(started_at,created_at), id
		FOR UPDATE SKIP LOCKED LIMIT $2`,
		max(int(runningStaleAfter/time.Second), 1), limit)
	if err != nil {
		return nil, err
	}
	stale := make([]domain.Execution, 0)
	for rows.Next() {
		execution, scanErr := scanExecution(rows)
		if scanErr != nil {
			rows.Close()
			return nil, scanErr
		}
		stale = append(stale, execution)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}

	recoveries := make([]ExecutionRecovery, 0, len(stale))
	for _, execution := range stale {
		priorState := execution.State
		reason := fmt.Sprintf("%s execution exceeded its stale recovery timeout", priorState)
		command, err := tx.Exec(ctx, `UPDATE executions SET state='failed',
            failure_classification='execution_stale', error=$2, completed_at=now()
            WHERE id=$1 AND state=$3`, execution.ID, reason, priorState)
		if err != nil {
			return nil, err
		}
		if command.RowsAffected() != 1 {
			continue
		}
		recovery := ExecutionRecovery{
			ExecutionID: execution.ID, Kind: execution.Kind, PriorState: priorState,
			Outcome: recoveryDecision(execution.Attempt, maxAttempts), Attempt: execution.Attempt,
		}
		if recovery.Outcome == RecoveryTerminal {
			if err := terminalizeStaleExecution(ctx, tx, execution, reason); err != nil {
				return nil, err
			}
			recoveries = append(recoveries, recovery)
			continue
		}

		replacementID, err := enqueueExecutionReplacement(ctx, tx, execution)
		if err != nil {
			return nil, err
		}
		recovery.ReplacementID = &replacementID
		recoveries = append(recoveries, recovery)
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return recoveries, nil
}

func enqueueExecutionReplacement(ctx context.Context, tx pgx.Tx, execution domain.Execution) (uuid.UUID, error) {
	replacementID := uuid.New()
	_, err := tx.Exec(ctx, `INSERT INTO executions
		(id, monitor_id, revision_id, kind, requested_generation, attempt, state, input, recovery_of)
		VALUES ($1,$2,$3,$4,$5,$6,'queued',$7,$8)`, replacementID, execution.MonitorID,
		execution.RevisionID, execution.Kind, execution.RequestedGeneration, execution.Attempt+1,
		execution.Input, execution.ID)
	if err != nil {
		return uuid.Nil, err
	}
	if execution.Kind == domain.ExecutionRepair {
		command, err := tx.Exec(ctx, `UPDATE repair_attempts SET execution_id=$2, state='queued',
			candidate_revision_id=NULL, outcome=NULL, completed_at=NULL WHERE execution_id=$1`,
			execution.ID, replacementID)
		if err != nil {
			return uuid.Nil, err
		}
		if command.RowsAffected() != 1 {
			return uuid.Nil, fmt.Errorf("repair execution %s has no repair attempt", execution.ID)
		}
	}
	message := domain.WorkMessage{SchemaVersion: domain.SchemaVersion, ExecutionID: replacementID,
		MonitorID: execution.MonitorID, RevisionID: execution.RevisionID}
	if err := insertOutbox(ctx, tx, recoverySubject(execution.Kind), message); err != nil {
		return uuid.Nil, err
	}
	return replacementID, nil
}

func terminalizeStaleExecution(ctx context.Context, tx pgx.Tx, execution domain.Execution, reason string) error {
	switch execution.Kind {
	case domain.ExecutionCompile:
		_, err := tx.Exec(ctx, `UPDATE monitors SET status='blocked', updated_at=now() WHERE id=$1`, execution.MonitorID)
		return err
	case domain.ExecutionRepair:
		if _, err := tx.Exec(ctx, `UPDATE repair_attempts SET state='failed', outcome=$2,
            completed_at=now() WHERE execution_id=$1`, execution.ID, reason); err != nil {
			return err
		}
		_, err := tx.Exec(ctx, `UPDATE monitors SET status='needs_review', next_run_at=NULL,
            updated_at=now() WHERE id=$1`, execution.MonitorID)
		return err
	default:
		return nil
	}
}

func recoveryDecision(attempt, maxAttempts int) string {
	if attempt >= maxAttempts {
		return RecoveryTerminal
	}
	return RecoveryRequeued
}

func recoverySubject(kind domain.ExecutionKind) string {
	return "scout.monitor." + string(kind)
}
