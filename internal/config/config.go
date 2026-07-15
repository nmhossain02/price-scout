package config

import (
	"fmt"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

type Config struct {
	HTTPAddr                   string
	DatabaseURL                string
	NATSURL                    string
	WorkerToken                string
	ArtifactRoot               string
	AllowedOrigin              string
	PublicURL                  string
	WebRoot                    string
	FixtureOrigin              string
	SchedulerInterval          time.Duration
	OutboxInterval             time.Duration
	ShutdownTimeout            time.Duration
	DefaultInterval            int
	MinInterval                int
	AlertWebhookURL            string
	AlertWebhookSecret         string
	DiscordWebhookURL          string
	ExecutionRunningStaleAfter time.Duration
	ExecutionMaxAttempts       int
}

func Load() (Config, error) {
	publicURL := strings.TrimRight(env("SCOUT_PUBLIC_URL", "http://127.0.0.1:3000"), "/")
	cfg := Config{
		HTTPAddr:                   env("SCOUT_HTTP_ADDR", "127.0.0.1:8080"),
		DatabaseURL:                env("DATABASE_URL", "postgres://scout:scout@127.0.0.1:5432/scout?sslmode=disable"),
		NATSURL:                    env("NATS_URL", "nats://127.0.0.1:4222"),
		WorkerToken:                envAlias("WORKER_API_TOKEN", "SCOUT_WORKER_TOKEN", "dev-worker-token"),
		ArtifactRoot:               envAlias("ARTIFACT_DIR", "SCOUT_ARTIFACT_ROOT", "./data/artifacts"),
		AllowedOrigin:              env("SCOUT_ALLOWED_ORIGIN", publicURL),
		PublicURL:                  publicURL,
		WebRoot:                    env("SCOUT_WEB_ROOT", "/app/web"),
		FixtureOrigin:              env("SCOUT_FIXTURE_ORIGIN", "http://fixture:4173"),
		SchedulerInterval:          duration("SCOUT_SCHEDULER_INTERVAL", 5*time.Second),
		OutboxInterval:             duration("SCOUT_OUTBOX_INTERVAL", 500*time.Millisecond),
		ShutdownTimeout:            duration("SCOUT_SHUTDOWN_TIMEOUT", 15*time.Second),
		DefaultInterval:            integerAlias("DEFAULT_INTERVAL_MINUTES", "SCOUT_DEFAULT_INTERVAL_MINUTES", 360),
		MinInterval:                integerAlias("MIN_INTERVAL_MINUTES", "SCOUT_MIN_INTERVAL_MINUTES", 15),
		AlertWebhookURL:            strings.TrimSpace(env("ALERT_WEBHOOK_URL", "")),
		AlertWebhookSecret:         env("ALERT_WEBHOOK_SECRET", ""),
		DiscordWebhookURL:          strings.TrimSpace(env("DISCORD_WEBHOOK_URL", "")),
		ExecutionRunningStaleAfter: duration("SCOUT_EXECUTION_RUNNING_STALE_AFTER", 5*time.Minute),
		ExecutionMaxAttempts:       integer("SCOUT_EXECUTION_MAX_ATTEMPTS", 3),
	}
	if cfg.WorkerToken == "" {
		return Config{}, fmt.Errorf("WORKER_API_TOKEN cannot be empty")
	}
	if cfg.DefaultInterval < cfg.MinInterval {
		return Config{}, fmt.Errorf("default interval must be at least minimum interval")
	}
	if cfg.ExecutionRunningStaleAfter < 3*time.Minute {
		return Config{}, fmt.Errorf("SCOUT_EXECUTION_RUNNING_STALE_AFTER must be at least 3m")
	}
	if cfg.ExecutionMaxAttempts < 1 || cfg.ExecutionMaxAttempts > 10 {
		return Config{}, fmt.Errorf("SCOUT_EXECUTION_MAX_ATTEMPTS must be between 1 and 10")
	}
	if err := validateHTTPURL("SCOUT_PUBLIC_URL", cfg.PublicURL); err != nil {
		return Config{}, err
	}
	parsedPublicURL, _ := url.Parse(cfg.PublicURL)
	if parsedPublicURL.RawQuery != "" || parsedPublicURL.Fragment != "" {
		return Config{}, fmt.Errorf("SCOUT_PUBLIC_URL cannot contain a query string or fragment")
	}
	if cfg.AlertWebhookURL != "" {
		if err := validateHTTPURL("ALERT_WEBHOOK_URL", cfg.AlertWebhookURL); err != nil {
			return Config{}, err
		}
		if cfg.AlertWebhookSecret == "" {
			return Config{}, fmt.Errorf("ALERT_WEBHOOK_SECRET is required when ALERT_WEBHOOK_URL is set")
		}
	}
	if cfg.DiscordWebhookURL != "" {
		if err := validateHTTPURL("DISCORD_WEBHOOK_URL", cfg.DiscordWebhookURL); err != nil {
			return Config{}, err
		}
	}
	return cfg, nil
}

func (c Config) EnabledAlertChannels() []string {
	channels := make([]string, 0, 2)
	if c.AlertWebhookURL != "" {
		channels = append(channels, "webhook")
	}
	if c.DiscordWebhookURL != "" {
		channels = append(channels, "discord")
	}
	return channels
}

func validateHTTPURL(name, raw string) error {
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Host == "" || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.User != nil {
		return fmt.Errorf("%s must be an absolute HTTP(S) URL without embedded credentials", name)
	}
	return nil
}

func envAlias(primary, legacy, fallback string) string {
	if value, ok := os.LookupEnv(primary); ok {
		return value
	}
	return env(legacy, fallback)
}

func env(key, fallback string) string {
	if value, ok := os.LookupEnv(key); ok {
		return value
	}
	return fallback
}

func duration(key string, fallback time.Duration) time.Duration {
	value, ok := os.LookupEnv(key)
	if !ok {
		return fallback
	}
	parsed, err := time.ParseDuration(value)
	if err != nil {
		return fallback
	}
	return parsed
}

func integer(key string, fallback int) int {
	value, ok := os.LookupEnv(key)
	if !ok {
		return fallback
	}
	parsed, err := strconv.Atoi(value)
	if err != nil {
		return fallback
	}
	return parsed
}

func integerAlias(primary, legacy string, fallback int) int {
	if value, ok := os.LookupEnv(primary); ok {
		parsed, err := strconv.Atoi(value)
		if err == nil {
			return parsed
		}
		return fallback
	}
	return integer(legacy, fallback)
}
