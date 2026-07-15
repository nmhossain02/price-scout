package store

import (
	"encoding/json"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/nmhossain02/price-scout/internal/domain"
)

const monitorColumns = `id, url, intent, interval_minutes, condition, status,
 current_revision_id, condition_matched, next_run_at, created_at, updated_at`

const qualifiedMonitorColumns = `m.id, m.url, m.intent, m.interval_minutes, m.condition, m.status,
 m.current_revision_id, m.condition_matched, m.next_run_at, m.created_at, m.updated_at`

func scanMonitor(row pgx.Row) (domain.Monitor, error) {
	var monitor domain.Monitor
	var revision pgtype.UUID
	var nextRun pgtype.Timestamptz
	err := row.Scan(
		&monitor.ID, &monitor.URL, &monitor.Intent, &monitor.IntervalMinutes,
		&monitor.Condition, &monitor.Status, &revision, &monitor.ConditionMatched,
		&nextRun, &monitor.CreatedAt, &monitor.UpdatedAt,
	)
	if revision.Valid {
		value := uuid.UUID(revision.Bytes)
		monitor.CurrentRevisionID = &value
	}
	if nextRun.Valid {
		value := nextRun.Time
		monitor.NextRunAt = &value
	}
	return monitor, err
}

func scanMonitorSummary(row pgx.Row) (domain.MonitorSummary, error) {
	var summary domain.MonitorSummary
	var revision pgtype.UUID
	var nextRun pgtype.Timestamptz
	var latestJSON []byte
	err := row.Scan(
		&summary.ID, &summary.URL, &summary.Intent, &summary.IntervalMinutes,
		&summary.Condition, &summary.Status, &revision, &summary.ConditionMatched,
		&nextRun, &summary.CreatedAt, &summary.UpdatedAt, &latestJSON,
	)
	if err != nil {
		return domain.MonitorSummary{}, err
	}
	if revision.Valid {
		value := uuid.UUID(revision.Bytes)
		summary.CurrentRevisionID = &value
	}
	if nextRun.Valid {
		value := nextRun.Time
		summary.NextRunAt = &value
	}
	latest, err := decodeLatestObservation(latestJSON)
	if err != nil {
		return domain.MonitorSummary{}, err
	}
	summary.LatestObservation = latest
	return summary, nil
}

func decodeLatestObservation(raw []byte) (*domain.Observation, error) {
	if len(raw) == 0 || string(raw) == "null" {
		return nil, nil
	}
	var observation domain.Observation
	if err := json.Unmarshal(raw, &observation); err != nil {
		return nil, err
	}
	return &observation, nil
}

const revisionColumns = `id, monitor_id, generation, plan, source, validation_state, activated_at, created_at`

func scanRevision(row pgx.Row) (domain.Revision, error) {
	var revision domain.Revision
	var activated pgtype.Timestamptz
	err := row.Scan(
		&revision.ID, &revision.MonitorID, &revision.Generation, &revision.Plan,
		&revision.Source, &revision.ValidationState, &activated, &revision.CreatedAt,
	)
	if activated.Valid {
		value := activated.Time
		revision.ActivatedAt = &value
	}
	return revision, err
}

const executionColumns = `id, monitor_id, revision_id, kind, requested_generation, attempt, recovery_of, state,
 failure_classification, provider, trace_id, browser_session_url, input, result, error,
 created_at, started_at, completed_at`

func scanExecution(row pgx.Row) (domain.Execution, error) {
	var execution domain.Execution
	var revision pgtype.UUID
	var recoveryOf pgtype.UUID
	var generation pgtype.Int4
	var failure, provider, traceID, browserURL, message pgtype.Text
	var started, completed pgtype.Timestamptz
	err := row.Scan(
		&execution.ID, &execution.MonitorID, &revision, &execution.Kind, &generation,
		&execution.Attempt, &recoveryOf, &execution.State, &failure, &provider, &traceID, &browserURL,
		&execution.Input, &execution.Result, &message, &execution.CreatedAt, &started, &completed,
	)
	if revision.Valid {
		value := uuid.UUID(revision.Bytes)
		execution.RevisionID = &value
	}
	if generation.Valid {
		value := int(generation.Int32)
		execution.RequestedGeneration = &value
	}
	if recoveryOf.Valid {
		value := uuid.UUID(recoveryOf.Bytes)
		execution.RecoveryOf = &value
	}
	execution.FailureClassification = textPointer(failure)
	execution.Provider = textPointer(provider)
	execution.TraceID = textPointer(traceID)
	execution.BrowserSessionURL = textPointer(browserURL)
	execution.Error = textPointer(message)
	if started.Valid {
		value := started.Time
		execution.StartedAt = &value
	}
	if completed.Valid {
		value := completed.Time
		execution.CompletedAt = &value
	}
	return execution, err
}

func textPointer(value pgtype.Text) *string {
	if !value.Valid {
		return nil
	}
	return &value.String
}

const observationColumns = `id, monitor_id, execution_id, price_minor, currency, in_stock, title,
 raw_text, identity, verification_state, condition_matched, observed_at`

func scanObservation(row pgx.Row) (domain.Observation, error) {
	var observation domain.Observation
	var rawText pgtype.Text
	err := row.Scan(
		&observation.ID, &observation.MonitorID, &observation.ExecutionID,
		&observation.PriceMinor, &observation.Currency, &observation.InStock,
		&observation.Title, &rawText, &observation.Identity,
		&observation.Verification, &observation.ConditionMatch, &observation.ObservedAt,
	)
	if rawText.Valid {
		observation.RawText = rawText.String
	}
	return observation, err
}
