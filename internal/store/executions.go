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

func (s *Store) GetExecution(ctx context.Context, id uuid.UUID) (domain.Execution, error) {
	execution, err := scanExecution(s.pool.QueryRow(ctx, `SELECT `+executionColumns+` FROM executions WHERE id=$1`, id))
	return execution, translateError(err)
}

func (s *Store) GetExecutionDetail(ctx context.Context, id uuid.UUID) (domain.ExecutionDetail, error) {
	execution, err := s.GetExecution(ctx, id)
	if err != nil {
		return domain.ExecutionDetail{}, err
	}
	detail := domain.ExecutionDetail{Execution: execution, Artifacts: []domain.Artifact{}}
	observation, observationErr := scanObservation(s.pool.QueryRow(ctx, `SELECT `+observationColumns+` FROM observations WHERE execution_id=$1`, id))
	if observationErr == nil {
		detail.Observation = &observation
	} else if observationErr != pgx.ErrNoRows {
		return domain.ExecutionDetail{}, observationErr
	}
	rows, err := s.pool.Query(ctx, `SELECT id, execution_id, kind, storage_key, content_type,
        COALESCE(sha256,''), COALESCE(size_bytes,0), created_at FROM artifacts WHERE execution_id=$1 ORDER BY created_at`, id)
	if err != nil {
		return domain.ExecutionDetail{}, err
	}
	defer rows.Close()
	for rows.Next() {
		var artifact domain.Artifact
		if err := rows.Scan(&artifact.ID, &artifact.ExecutionID, &artifact.Kind, &artifact.StorageKey,
			&artifact.ContentType, &artifact.SHA256, &artifact.SizeBytes, &artifact.CreatedAt); err != nil {
			return domain.ExecutionDetail{}, err
		}
		detail.Artifacts = append(detail.Artifacts, artifact)
	}
	return detail, rows.Err()
}

func (s *Store) GetExecutionInput(ctx context.Context, id uuid.UUID) (domain.ExecutionInput, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return domain.ExecutionInput{}, err
	}
	defer tx.Rollback(ctx)
	execution, err := scanExecution(tx.QueryRow(ctx, `SELECT `+executionColumns+` FROM executions WHERE id=$1 FOR UPDATE`, id))
	if err != nil {
		return domain.ExecutionInput{}, translateError(err)
	}
	if execution.State == "queued" {
		_, err = tx.Exec(ctx, `UPDATE executions SET state='running', started_at=COALESCE(started_at,now()) WHERE id=$1`, id)
		if err != nil {
			return domain.ExecutionInput{}, err
		}
		execution.State = "running"
		if execution.Kind == domain.ExecutionRepair {
			_, err = tx.Exec(ctx, `UPDATE repair_attempts SET state='running' WHERE execution_id=$1 AND state='queued'`, id)
			if err != nil {
				return domain.ExecutionInput{}, err
			}
		}
	} else if execution.State == "running" {
		// A JetStream redelivery that reaches the control plane renews the
		// Postgres-side attempt age. Long browser work remains bounded by the
		// configured worker timeout plus the scheduler's recovery margin.
		_, err = tx.Exec(ctx, `UPDATE executions SET started_at=now() WHERE id=$1 AND state='running'`, id)
		if err != nil {
			return domain.ExecutionInput{}, err
		}
	}
	monitor, err := scanMonitor(tx.QueryRow(ctx, `SELECT `+monitorColumns+` FROM monitors WHERE id=$1`, execution.MonitorID))
	if err != nil {
		return domain.ExecutionInput{}, err
	}
	input := domain.ExecutionInput{SchemaVersion: domain.SchemaVersion, Execution: execution, Monitor: monitor}
	if execution.RevisionID != nil {
		revision, revisionErr := scanRevision(tx.QueryRow(ctx, `SELECT `+revisionColumns+` FROM monitor_revisions WHERE id=$1`, *execution.RevisionID))
		if revisionErr != nil {
			return domain.ExecutionInput{}, revisionErr
		}
		input.Revision = &revision
		input.Plan = revision.Plan
	}
	if err := tx.Commit(ctx); err != nil {
		return domain.ExecutionInput{}, err
	}
	return input, nil
}

func (s *Store) EnqueueCheck(ctx context.Context, monitorID uuid.UUID, idempotencyKey, traceparent string) (domain.Execution, bool, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return domain.Execution{}, false, err
	}
	defer tx.Rollback(ctx)
	if idempotencyKey != "" {
		existing, scanErr := scanExecution(tx.QueryRow(ctx, `SELECT `+executionColumns+` FROM executions WHERE monitor_id=$1 AND idempotency_key=$2`, monitorID, idempotencyKey))
		if scanErr == nil {
			return existing, false, nil
		}
		if scanErr != pgx.ErrNoRows {
			return domain.Execution{}, false, scanErr
		}
	}
	monitor, err := scanMonitor(tx.QueryRow(ctx, `SELECT `+monitorColumns+` FROM monitors WHERE id=$1 FOR UPDATE`, monitorID))
	if err != nil {
		return domain.Execution{}, false, translateError(err)
	}
	if monitor.Status != domain.MonitorActive || monitor.CurrentRevisionID == nil {
		return domain.Execution{}, false, ErrConflict
	}
	var executionInFlight bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS (
        SELECT 1 FROM executions WHERE monitor_id=$1 AND state IN ('queued','running')
    )`, monitorID).Scan(&executionInFlight); err != nil {
		return domain.Execution{}, false, err
	}
	if executionInFlight {
		return domain.Execution{}, false, ErrConflict
	}
	var generation int
	if err := tx.QueryRow(ctx, `SELECT generation FROM monitor_revisions WHERE id=$1`, *monitor.CurrentRevisionID).Scan(&generation); err != nil {
		return domain.Execution{}, false, err
	}
	executionID := uuid.New()
	_, err = tx.Exec(ctx, `INSERT INTO executions
        (id, monitor_id, revision_id, kind, requested_generation, state, idempotency_key)
        VALUES ($1,$2,$3,'check',$4,'queued',NULLIF($5,''))`, executionID, monitorID, *monitor.CurrentRevisionID, generation, idempotencyKey)
	if err != nil {
		return domain.Execution{}, false, err
	}
	message := domain.WorkMessage{SchemaVersion: domain.SchemaVersion, ExecutionID: executionID, MonitorID: monitorID, RevisionID: monitor.CurrentRevisionID, Traceparent: traceparent}
	if err := insertOutbox(ctx, tx, "scout.monitor.check", message); err != nil {
		return domain.Execution{}, false, err
	}
	if err := tx.Commit(ctx); err != nil {
		return domain.Execution{}, false, err
	}
	execution, err := s.GetExecution(ctx, executionID)
	return execution, true, err
}

func (s *Store) ApplyResult(ctx context.Context, executionID uuid.UUID, result domain.ExecutionResult) (domain.Execution, bool, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return domain.Execution{}, false, err
	}
	defer tx.Rollback(ctx)
	execution, err := scanExecution(tx.QueryRow(ctx, `SELECT `+executionColumns+` FROM executions WHERE id=$1 FOR UPDATE`, executionID))
	if err != nil {
		return domain.Execution{}, false, translateError(err)
	}
	if isTerminalExecution(execution.State) {
		if err := tx.Commit(ctx); err != nil {
			return domain.Execution{}, false, err
		}
		return execution, false, nil
	}
	if !validResultStatus(result.Status) {
		return domain.Execution{}, false, fmt.Errorf("%w: invalid status %q", ErrInvalidResult, result.Status)
	}
	if err := validateResult(execution, result); err != nil {
		return domain.Execution{}, false, err
	}
	rawResult, err := json.Marshal(result)
	if err != nil {
		return domain.Execution{}, false, err
	}
	_, err = tx.Exec(ctx, `UPDATE executions SET state=$2, failure_classification=NULLIF($3,''),
        provider=NULLIF($4,''), trace_id=NULLIF($5,''), browser_session_url=NULLIF($6,''),
        result=$7, error=NULLIF($8,''), completed_at=now(), started_at=COALESCE(started_at,now())
        WHERE id=$1`, executionID, result.Status, result.FailureClassification, result.Provider,
		result.TraceID, result.BrowserSessionURL, rawResult, result.Error)
	if err != nil {
		return domain.Execution{}, false, err
	}

	for _, artifact := range result.Artifacts {
		if !validArtifact(execution, artifact) {
			return domain.Execution{}, false, fmt.Errorf("%w: artifact metadata or storage path is invalid", ErrInvalidResult)
		}
		_, err = tx.Exec(ctx, `INSERT INTO artifacts
            (id, execution_id, kind, storage_key, content_type, sha256, size_bytes)
            VALUES ($1,$2,$3,$4,$5,NULLIF($6,''),NULLIF($7,0))
            ON CONFLICT (execution_id, storage_key) DO NOTHING`, uuid.New(), executionID,
			artifact.Kind, artifact.StorageKey, artifact.ContentType, artifact.SHA256, artifact.SizeBytes)
		if err != nil {
			return domain.Execution{}, false, err
		}
	}

	if result.Status == "succeeded" && len(result.Plan) > 0 && (execution.Kind == domain.ExecutionCompile || execution.Kind == domain.ExecutionRepair) {
		if err := s.applyPlanResult(ctx, tx, execution, result); err != nil {
			return domain.Execution{}, false, err
		}
	}
	if result.Observation != nil && result.Status == "succeeded" {
		if err := s.applyObservation(ctx, tx, execution, *result.Observation); err != nil {
			return domain.Execution{}, false, err
		}
	}
	if result.Status != "succeeded" {
		if err := s.applyFailure(ctx, tx, execution, result); err != nil {
			return domain.Execution{}, false, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return domain.Execution{}, false, err
	}
	updated, err := s.GetExecution(ctx, executionID)
	return updated, true, err
}

func (s *Store) applyPlanResult(ctx context.Context, tx pgx.Tx, execution domain.Execution, result domain.ExecutionResult) error {
	var generation int
	if err := tx.QueryRow(ctx, `SELECT COALESCE(max(generation),0)+1 FROM monitor_revisions WHERE monitor_id=$1`, execution.MonitorID).Scan(&generation); err != nil {
		return err
	}
	revisionID := uuid.New()
	validationState := "awaiting_confirmation"
	if execution.Kind == domain.ExecutionRepair {
		validationState = "candidate"
	}
	_, err := tx.Exec(ctx, `INSERT INTO monitor_revisions
        (id, monitor_id, generation, plan, source, validation_state)
        VALUES ($1,$2,$3,$4,$5,$6)`, revisionID, execution.MonitorID, generation,
		result.Plan, string(execution.Kind), validationState)
	if err != nil {
		return err
	}
	if execution.Kind == domain.ExecutionCompile {
		_, err = tx.Exec(ctx, `UPDATE monitors SET status='awaiting_confirmation', updated_at=now() WHERE id=$1`, execution.MonitorID)
		return err
	}
	_, err = tx.Exec(ctx, `UPDATE repair_attempts SET state='candidate', candidate_revision_id=$2, completed_at=now()
        WHERE execution_id=$1`, execution.ID, revisionID)
	if err != nil {
		return err
	}
	if result.AutoPromote && execution.RevisionID != nil {
		command, updateErr := tx.Exec(ctx, `UPDATE monitors SET current_revision_id=$3, status='active',
			next_run_at=now() + make_interval(mins => interval_minutes), updated_at=now()
            WHERE id=$1 AND current_revision_id=$2`, execution.MonitorID, *execution.RevisionID, revisionID)
		if updateErr != nil {
			return updateErr
		}
		if command.RowsAffected() == 1 {
			_, err = tx.Exec(ctx, `UPDATE monitor_revisions SET validation_state='active', activated_at=now() WHERE id=$1`, revisionID)
			if err == nil {
				_, err = tx.Exec(ctx, `UPDATE repair_attempts SET state='activated' WHERE execution_id=$1`, execution.ID)
			}
			return err
		}
	}
	_, err = tx.Exec(ctx, `UPDATE monitors SET status='needs_review', updated_at=now() WHERE id=$1`, execution.MonitorID)
	return err
}

func (s *Store) applyObservation(ctx context.Context, tx pgx.Tx, execution domain.Execution, observation domain.ResultObservation) error {
	if observation.PriceMinor <= 0 || len(observation.Currency) != 3 || strings.TrimSpace(observation.Title) == "" {
		return fmt.Errorf("%w: observation requires positive priceMinor, ISO currency, and title", ErrInvalidResult)
	}
	var condition json.RawMessage
	var previousMatched bool
	if err := tx.QueryRow(ctx, `SELECT condition, condition_matched FROM monitors WHERE id=$1 FOR UPDATE`, execution.MonitorID).Scan(&condition, &previousMatched); err != nil {
		return err
	}
	matched := MatchesCondition(condition, observation)
	if observation.ConditionMatched != nil {
		matched = *observation.ConditionMatched
	}
	verification := observation.VerificationState
	if verification == "" {
		verification = "verified"
	}
	if verification != "verified" && verification != "review_required" {
		return fmt.Errorf("%w: unsupported verification state %q", ErrInvalidResult, verification)
	}
	observationID := uuid.New()
	_, err := tx.Exec(ctx, `INSERT INTO observations
        (id, monitor_id, execution_id, price_minor, currency, in_stock, title, raw_text, identity, verification_state, condition_matched)
        VALUES ($1,$2,$3,$4,upper($5),$6,$7,NULLIF($8,''),COALESCE($9,'{}'::jsonb),$10,$11)`,
		observationID, execution.MonitorID, execution.ID, observation.PriceMinor, observation.Currency,
		observation.InStock, observation.Title, observation.RawText, nullableJSON(observation.Identity), verification, matched)
	if err != nil {
		return err
	}
	// Repair observations are diagnostic. A subsequent normal check must confirm
	// the condition before an alert is emitted.
	if execution.Kind == domain.ExecutionCheck && verification == "verified" {
		confirmation := executionIsAlertConfirmation(execution)
		if confirmation {
			_, err = tx.Exec(ctx, `UPDATE monitors SET condition_matched=$2, updated_at=now() WHERE id=$1`, execution.MonitorID, matched)
			if err != nil {
				return err
			}
		} else if !matched {
			// Ordinary non-matches rearm an alert condition immediately.
			_, err = tx.Exec(ctx, `UPDATE monitors SET condition_matched=false, updated_at=now() WHERE id=$1`, execution.MonitorID)
			if err != nil {
				return err
			}
		}
		if confirmation && matched && !previousMatched {
			idempotencyKey := "condition:" + execution.MonitorID.String() + ":" + observationID.String()
			if err = s.createAlert(ctx, tx, execution.MonitorID, observationID, idempotencyKey); err != nil {
				return err
			}
		} else if !confirmation && matched && !previousMatched {
			if err := enqueueAlertConfirmation(ctx, tx, execution, observationID); err != nil {
				return err
			}
		}
	}
	return nil
}

func enqueueAlertConfirmation(ctx context.Context, tx pgx.Tx, execution domain.Execution, triggerObservationID uuid.UUID) error {
	var pending bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS (
        SELECT 1 FROM executions WHERE monitor_id=$1 AND kind='check'
        AND state IN ('queued','running') AND input @> '{"alertConfirmation":true}'::jsonb
    )`, execution.MonitorID).Scan(&pending); err != nil {
		return err
	}
	if pending {
		return nil
	}
	confirmationID := uuid.New()
	input, _ := json.Marshal(map[string]any{"alertConfirmation": true, "triggerObservationId": triggerObservationID})
	_, err := tx.Exec(ctx, `INSERT INTO executions
        (id, monitor_id, revision_id, kind, requested_generation, state, input)
        VALUES ($1,$2,$3,'check',$4,'queued',$5)`, confirmationID, execution.MonitorID,
		execution.RevisionID, execution.RequestedGeneration, input)
	if err != nil {
		return err
	}
	message := domain.WorkMessage{SchemaVersion: domain.SchemaVersion, ExecutionID: confirmationID,
		MonitorID: execution.MonitorID, RevisionID: execution.RevisionID}
	return insertOutbox(ctx, tx, "scout.monitor.check", message)
}

func executionIsAlertConfirmation(execution domain.Execution) bool {
	var input struct {
		AlertConfirmation bool `json:"alertConfirmation"`
	}
	return len(execution.Input) > 0 && json.Unmarshal(execution.Input, &input) == nil && input.AlertConfirmation
}

func (s *Store) applyFailure(ctx context.Context, tx pgx.Tx, execution domain.Execution, result domain.ExecutionResult) error {
	if shouldRetryExecutionResult(execution, result, s.maxExecutionAttempts) {
		_, err := enqueueExecutionReplacement(ctx, tx, execution)
		return err
	}
	if execution.Kind == domain.ExecutionCompile {
		status := "blocked"
		if result.Status == "needs_review" {
			status = "needs_review"
		}
		_, err := tx.Exec(ctx, `UPDATE monitors SET status=$2, updated_at=now() WHERE id=$1`, execution.MonitorID, status)
		return err
	}
	if execution.Kind == domain.ExecutionRepair {
		_, err := tx.Exec(ctx, `UPDATE repair_attempts SET state='failed', outcome=COALESCE(NULLIF($2,''),NULLIF($3,''),'repair failed'), completed_at=now()
            WHERE execution_id=$1`, execution.ID, result.FailureClassification, result.Error)
		if err != nil {
			return err
		}
		_, err = tx.Exec(ctx, `UPDATE monitors SET status='needs_review', next_run_at=NULL, updated_at=now() WHERE id=$1`, execution.MonitorID)
		return err
	}
	if execution.Kind != domain.ExecutionCheck || execution.RequestedGeneration == nil ||
		(result.FailureClassification != "stale_action" && result.FailureClassification != "stale_extractor") {
		if result.Status == "blocked" || result.FailureClassification == "blocked" {
			_, err := tx.Exec(ctx, `UPDATE monitors SET status='blocked', updated_at=now() WHERE id=$1`, execution.MonitorID)
			return err
		}
		if result.Status == "needs_review" || result.FailureClassification == "ambiguous_value" || result.FailureClassification == "identity_drift" {
			_, err := tx.Exec(ctx, `UPDATE monitors SET status='needs_review', next_run_at=NULL, updated_at=now() WHERE id=$1`, execution.MonitorID)
			return err
		}
		return nil
	}
	// Serialize repair creation for this monitor. Combined with the unique
	// constraint, this prevents a fleet-wide repair stampede.
	if _, err := tx.Exec(ctx, `SELECT 1 FROM monitors WHERE id=$1 FOR UPDATE`, execution.MonitorID); err != nil {
		return err
	}
	var existing uuid.UUID
	err := tx.QueryRow(ctx, `SELECT execution_id FROM repair_attempts WHERE monitor_id=$1 AND failed_generation=$2`, execution.MonitorID, *execution.RequestedGeneration).Scan(&existing)
	if err == nil {
		return nil
	}
	if err != pgx.ErrNoRows {
		return err
	}
	repairExecutionID := uuid.New()
	_, err = tx.Exec(ctx, `INSERT INTO executions
        (id, monitor_id, revision_id, kind, requested_generation, state)
        VALUES ($1,$2,$3,'repair',$4,'queued')`, repairExecutionID, execution.MonitorID, execution.RevisionID, *execution.RequestedGeneration)
	if err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `INSERT INTO repair_attempts
        (id, monitor_id, failed_generation, execution_id, state)
        VALUES ($1,$2,$3,$4,'queued')`, uuid.New(), execution.MonitorID, *execution.RequestedGeneration, repairExecutionID)
	if err != nil {
		return err
	}
	message := domain.WorkMessage{SchemaVersion: domain.SchemaVersion, ExecutionID: repairExecutionID, MonitorID: execution.MonitorID, RevisionID: execution.RevisionID}
	if err := insertOutbox(ctx, tx, "scout.monitor.repair", message); err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `UPDATE monitors SET status='needs_review', next_run_at=NULL, updated_at=now() WHERE id=$1`, execution.MonitorID)
	return err
}

func shouldRetryExecutionResult(execution domain.Execution, result domain.ExecutionResult, maxAttempts int) bool {
	if result.Status != "failed" || execution.Attempt >= maxAttempts ||
		(execution.Kind != domain.ExecutionCompile && execution.Kind != domain.ExecutionRepair) {
		return false
	}
	return result.FailureClassification == "transient_infrastructure" || result.FailureClassification == "rate_limited"
}

func MatchesCondition(raw json.RawMessage, observation domain.ResultObservation) bool {
	var condition struct {
		PriceBelowMinor *int64 `json:"priceBelowMinor"`
		MaxPriceMinor   *int64 `json:"maxPriceMinor"`
		Currency        string `json:"currency"`
		RequireInStock  bool   `json:"requireInStock"`
	}
	if len(raw) == 0 || json.Unmarshal(raw, &condition) != nil {
		return false
	}
	if condition.PriceBelowMinor == nil && condition.MaxPriceMinor == nil {
		return false
	}
	if condition.Currency != "" && !strings.EqualFold(condition.Currency, observation.Currency) {
		return false
	}
	if condition.RequireInStock && !observation.InStock {
		return false
	}
	if condition.PriceBelowMinor != nil {
		return observation.PriceMinor < *condition.PriceBelowMinor
	}
	// maxPriceMinor predates the canonical condition name and was inclusive.
	// Preserve that boundary for stored legacy monitors while new API inputs use
	// the unambiguous strict "below" condition above.
	return observation.PriceMinor <= *condition.MaxPriceMinor
}

func nullableJSON(raw json.RawMessage) any {
	if len(raw) == 0 {
		return nil
	}
	return raw
}

func validResultStatus(state string) bool {
	switch state {
	case "succeeded", "failed", "blocked", "needs_review":
		return true
	default:
		return false
	}
}

func validArtifact(execution domain.Execution, artifact domain.ResultArtifact) bool {
	key := strings.ReplaceAll(artifact.StorageKey, "\\", "/")
	clean := strings.TrimPrefix(strings.TrimSpace(key), "./")
	if clean == "" || strings.HasPrefix(clean, "/") || strings.Contains(clean, "../") ||
		!strings.HasPrefix(clean, execution.ID.String()+"/") || artifact.SizeBytes < 0 || artifact.SizeBytes > 50<<20 {
		return false
	}
	switch artifact.ContentType {
	case "image/png", "text/plain", "application/json":
		return strings.TrimSpace(artifact.Kind) != ""
	default:
		return false
	}
}

func validateResult(execution domain.Execution, result domain.ExecutionResult) error {
	if result.Status != "succeeded" {
		if result.Error == "" && result.FailureClassification == "" {
			return fmt.Errorf("%w: failed result requires error or failureClassification", ErrInvalidResult)
		}
		return nil
	}
	switch execution.Kind {
	case domain.ExecutionCompile, domain.ExecutionRepair:
		if len(result.Plan) == 0 || !json.Valid(result.Plan) {
			return fmt.Errorf("%w: successful %s result requires a valid plan", ErrInvalidResult, execution.Kind)
		}
	case domain.ExecutionCheck:
		if result.Observation == nil {
			return fmt.Errorf("%w: successful check result requires an observation", ErrInvalidResult)
		}
	}
	return nil
}

func isTerminalExecution(state string) bool {
	switch state {
	case "succeeded", "failed", "blocked", "needs_review":
		return true
	default:
		return false
	}
}
