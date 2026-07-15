package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/nmhossain02/price-scout/internal/alertdelivery"
	"github.com/nmhossain02/price-scout/internal/config"
	"github.com/nmhossain02/price-scout/internal/events"
	"github.com/nmhossain02/price-scout/internal/httpapi"
	"github.com/nmhossain02/price-scout/internal/metrics"
	"github.com/nmhossain02/price-scout/internal/outbox"
	"github.com/nmhossain02/price-scout/internal/queue"
	"github.com/nmhossain02/price-scout/internal/scheduler"
	"github.com/nmhossain02/price-scout/internal/schedulerhttp"
	"github.com/nmhossain02/price-scout/internal/store"
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))
	if err := run(logger); err != nil {
		logger.Error("price scout stopped", "error", err)
		os.Exit(1)
	}
}

func run(logger *slog.Logger) error {
	command := "api"
	if len(os.Args) > 1 {
		command = os.Args[1]
	}
	if command != "api" && command != "scheduler" && command != "all" && command != "migrate" {
		return fmt.Errorf("unknown command %q; expected api, scheduler, all, or migrate", command)
	}
	cfg, err := config.Load()
	if err != nil {
		return err
	}
	rootContext, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	if err := migrateWithRetry(rootContext, cfg.DatabaseURL, logger); err != nil {
		return err
	}
	if command == "migrate" {
		logger.Info("database migrations complete")
		return nil
	}
	repository, err := store.Open(rootContext, cfg.DatabaseURL, store.Options{
		AlertChannels: cfg.EnabledAlertChannels(), MaxExecutionAttempts: cfg.ExecutionMaxAttempts,
	})
	if err != nil {
		return err
	}
	defer repository.Close()
	workQueue, err := queue.Connect(cfg.NATSURL)
	if err != nil {
		return err
	}
	defer workQueue.Close()
	telemetry := metrics.New()
	outboxRunner := outbox.New(repository, workQueue, telemetry, cfg.OutboxInterval, logger)
	go outboxRunner.Run(rootContext)

	errChannel := make(chan error, 2)
	if command == "scheduler" || command == "all" {
		scheduled := scheduler.New(repository, telemetry, cfg.SchedulerInterval, scheduler.RecoveryConfig{
			RunningStaleAfter: cfg.ExecutionRunningStaleAfter,
			MaxAttempts:       cfg.ExecutionMaxAttempts,
			BatchSize:         100,
		}, logger)
		go scheduled.Run(rootContext)
		logger.Info("scheduler started", "interval", cfg.SchedulerInterval,
			"running_stale_after", cfg.ExecutionRunningStaleAfter,
			"max_execution_attempts", cfg.ExecutionMaxAttempts)
	}
	var httpServer *http.Server
	if command == "scheduler" {
		httpServer = &http.Server{
			Addr:              cfg.HTTPAddr,
			Handler:           schedulerhttp.New(repository, workQueue, telemetry.Registry),
			ReadHeaderTimeout: 5 * time.Second,
			ReadTimeout:       5 * time.Second,
			WriteTimeout:      15 * time.Second,
			IdleTimeout:       60 * time.Second,
		}
		go func() {
			logger.Info("scheduler health and metrics listening", "address", cfg.HTTPAddr)
			if serveErr := httpServer.ListenAndServe(); serveErr != nil && !errors.Is(serveErr, http.ErrServerClosed) {
				errChannel <- serveErr
			}
		}()
	}
	if command == "api" || command == "all" {
		deliveries := alertdelivery.New(cfg, repository, telemetry, logger)
		go deliveries.Run(rootContext)
		api := httpapi.New(cfg, repository, workQueue, events.New(), telemetry, logger)
		httpServer = &http.Server{
			Addr:              cfg.HTTPAddr,
			Handler:           api.Handler(),
			ReadHeaderTimeout: 5 * time.Second,
			ReadTimeout:       35 * time.Second,
			WriteTimeout:      0, // SSE streams intentionally remain open.
			IdleTimeout:       60 * time.Second,
		}
		go func() {
			logger.Info("api listening", "address", cfg.HTTPAddr)
			if serveErr := httpServer.ListenAndServe(); serveErr != nil && !errors.Is(serveErr, http.ErrServerClosed) {
				errChannel <- serveErr
			}
		}()
	}

	select {
	case <-rootContext.Done():
	case err := <-errChannel:
		stop()
		return err
	}
	if httpServer != nil {
		shutdownContext, cancel := context.WithTimeout(context.Background(), cfg.ShutdownTimeout)
		defer cancel()
		if err := httpServer.Shutdown(shutdownContext); err != nil {
			return fmt.Errorf("shutdown api: %w", err)
		}
	}
	logger.Info("shutdown complete")
	return nil
}

func migrateWithRetry(ctx context.Context, databaseURL string, logger *slog.Logger) error {
	var lastError error
	for attempt := 1; attempt <= 30; attempt++ {
		migrationContext, cancel := context.WithTimeout(ctx, 10*time.Second)
		lastError = store.Migrate(migrationContext, databaseURL)
		cancel()
		if lastError == nil {
			return nil
		}
		if ctx.Err() != nil {
			return ctx.Err()
		}
		logger.Warn("database migration unavailable; retrying", "attempt", attempt, "error", lastError)
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(2 * time.Second):
		}
	}
	return fmt.Errorf("database migration failed after retries: %w", lastError)
}
