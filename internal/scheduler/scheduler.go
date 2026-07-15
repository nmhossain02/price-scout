package scheduler

import (
	"context"
	"log/slog"
	"time"

	"github.com/nmhossain02/price-scout/internal/metrics"
	"github.com/nmhossain02/price-scout/internal/store"
)

type Scheduler struct {
	store          *store.Store
	metrics        *metrics.Metrics
	interval       time.Duration
	recoveryConfig RecoveryConfig
	logger         *slog.Logger
}

type RecoveryConfig struct {
	RunningStaleAfter time.Duration
	MaxAttempts       int
	BatchSize         int
}

func New(repository *store.Store, telemetry *metrics.Metrics, interval time.Duration, recovery RecoveryConfig, logger *slog.Logger) *Scheduler {
	return &Scheduler{
		store: repository, metrics: telemetry, interval: interval,
		recoveryConfig: recovery, logger: logger,
	}
}

func (s *Scheduler) Run(ctx context.Context) {
	ticker := time.NewTicker(s.interval)
	defer ticker.Stop()
	for {
		recoveries, err := s.store.SweepStaleExecutions(ctx, s.recoveryConfig.RunningStaleAfter,
			s.recoveryConfig.MaxAttempts, s.recoveryConfig.BatchSize)
		if err != nil && ctx.Err() == nil {
			s.logger.Error("sweep stale executions", "error", err)
		} else if len(recoveries) > 0 {
			recordExecutionRecoveries(s.metrics, recoveries)
			for _, recovery := range recoveries {
				attributes := []any{
					"execution_id", recovery.ExecutionID,
					"kind", recovery.Kind,
					"prior_state", recovery.PriorState,
					"attempt", recovery.Attempt,
					"outcome", recovery.Outcome,
				}
				if recovery.ReplacementID != nil {
					attributes = append(attributes, "replacement_id", *recovery.ReplacementID)
				}
				s.logger.Warn("recovered stale execution", attributes...)
			}
		}

		count, err := s.store.ClaimDueMonitors(ctx, 100)
		if err != nil && ctx.Err() == nil {
			s.logger.Error("schedule due monitors", "error", err)
		} else if count > 0 {
			s.metrics.ScheduledChecks.Add(float64(count))
			s.logger.Info("scheduled monitor checks", "count", count)
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

func recordExecutionRecoveries(telemetry *metrics.Metrics, recoveries []store.ExecutionRecovery) {
	for _, recovery := range recoveries {
		telemetry.ExecutionRecoveries.WithLabelValues(
			string(recovery.Kind), recovery.Outcome, recovery.PriorState,
		).Inc()
	}
}
