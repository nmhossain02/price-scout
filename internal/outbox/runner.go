package outbox

import (
	"context"
	"log/slog"
	"time"

	"github.com/nmhossain02/price-scout/internal/metrics"
	"github.com/nmhossain02/price-scout/internal/queue"
	"github.com/nmhossain02/price-scout/internal/store"
)

type Runner struct {
	store    *store.Store
	queue    *queue.Client
	metrics  *metrics.Metrics
	interval time.Duration
	logger   *slog.Logger
}

func New(repository *store.Store, client *queue.Client, telemetry *metrics.Metrics, interval time.Duration, logger *slog.Logger) *Runner {
	return &Runner{store: repository, queue: client, metrics: telemetry, interval: interval, logger: logger}
}

func (r *Runner) Run(ctx context.Context) {
	ticker := time.NewTicker(r.interval)
	defer ticker.Stop()
	for {
		r.process(ctx)
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

func (r *Runner) process(ctx context.Context) {
	count, err := r.store.ProcessOutbox(ctx, 100, func(ctx context.Context, message store.OutboxMessage) error {
		if err := r.queue.PublishOutbox(ctx, message); err != nil {
			return err
		}
		r.metrics.OutboxPublished.WithLabelValues(message.Subject).Inc()
		return nil
	})
	if err != nil && ctx.Err() == nil {
		r.logger.Error("outbox publish failed", "error", err)
		return
	}
	if count > 0 {
		r.logger.Debug("published outbox batch", "count", count)
	}
}
