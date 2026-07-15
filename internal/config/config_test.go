package config

import (
	"testing"
	"time"
)

func TestAlertConfiguration(t *testing.T) {
	t.Setenv("WORKER_API_TOKEN", "worker-token")
	t.Setenv("SCOUT_PUBLIC_URL", "http://127.0.0.1:3000/")
	t.Setenv("ALERT_WEBHOOK_URL", "https://hooks.example/price-scout")
	t.Setenv("ALERT_WEBHOOK_SECRET", "secret")
	t.Setenv("DISCORD_WEBHOOK_URL", "https://discord.example/webhook")
	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.PublicURL != "http://127.0.0.1:3000" {
		t.Fatalf("public URL was not normalized: %q", cfg.PublicURL)
	}
	channels := cfg.EnabledAlertChannels()
	if len(channels) != 2 || channels[0] != "webhook" || channels[1] != "discord" {
		t.Fatalf("unexpected enabled channels: %v", channels)
	}
}

func TestWebhookRequiresSigningSecret(t *testing.T) {
	t.Setenv("WORKER_API_TOKEN", "worker-token")
	t.Setenv("SCOUT_PUBLIC_URL", "http://127.0.0.1:3000")
	t.Setenv("ALERT_WEBHOOK_URL", "https://hooks.example/price-scout")
	t.Setenv("ALERT_WEBHOOK_SECRET", "")
	if _, err := Load(); err == nil {
		t.Fatal("unsigned generic webhook configuration was accepted")
	}
}

func TestPublicURLRejectsQueryString(t *testing.T) {
	t.Setenv("WORKER_API_TOKEN", "worker-token")
	t.Setenv("SCOUT_PUBLIC_URL", "http://127.0.0.1:3000/?token=secret")
	t.Setenv("ALERT_WEBHOOK_URL", "")
	t.Setenv("DISCORD_WEBHOOK_URL", "")
	if _, err := Load(); err == nil {
		t.Fatal("public URL with a query string was accepted")
	}
}

func TestExecutionRecoveryConfiguration(t *testing.T) {
	t.Setenv("WORKER_API_TOKEN", "worker-token")
	t.Setenv("SCOUT_PUBLIC_URL", "http://127.0.0.1:3000")
	t.Setenv("ALERT_WEBHOOK_URL", "")
	t.Setenv("DISCORD_WEBHOOK_URL", "")
	t.Setenv("SCOUT_EXECUTION_RUNNING_STALE_AFTER", "4m")
	t.Setenv("SCOUT_EXECUTION_MAX_ATTEMPTS", "4")
	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.ExecutionRunningStaleAfter != 4*time.Minute || cfg.ExecutionMaxAttempts != 4 {
		t.Fatalf("unexpected recovery configuration: running=%s attempts=%d",
			cfg.ExecutionRunningStaleAfter, cfg.ExecutionMaxAttempts)
	}
}

func TestExecutionRecoveryTimeoutMustExceedWorkerBudget(t *testing.T) {
	t.Setenv("WORKER_API_TOKEN", "worker-token")
	t.Setenv("SCOUT_PUBLIC_URL", "http://127.0.0.1:3000")
	t.Setenv("ALERT_WEBHOOK_URL", "")
	t.Setenv("DISCORD_WEBHOOK_URL", "")
	t.Setenv("SCOUT_EXECUTION_RUNNING_STALE_AFTER", "2m")
	if _, err := Load(); err == nil {
		t.Fatal("running stale timeout at the worker's default job budget was accepted")
	}
}
