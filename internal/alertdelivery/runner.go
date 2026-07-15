package alertdelivery

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/nmhossain02/price-scout/internal/config"
	"github.com/nmhossain02/price-scout/internal/metrics"
	"github.com/nmhossain02/price-scout/internal/store"
)

const (
	maxAttempts    = 6
	claimBatch     = 8
	claimLease     = 45 * time.Second
	pollInterval   = time.Second
	reconcileEvery = time.Minute
)

type Runner struct {
	store         *store.Store
	metrics       *metrics.Metrics
	logger        *slog.Logger
	client        *http.Client
	owner         uuid.UUID
	publicURL     string
	webhookURL    string
	webhookSecret string
	discordURL    string
	now           func() time.Time
}

func New(cfg config.Config, repository *store.Store, telemetry *metrics.Metrics, logger *slog.Logger) *Runner {
	client := &http.Client{
		Timeout: 15 * time.Second,
		CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
			// Do not forward signatures or Discord payloads to a redirected host.
			return http.ErrUseLastResponse
		},
	}
	return &Runner{
		store: repository, metrics: telemetry, logger: logger, client: client,
		owner: uuid.New(), publicURL: strings.TrimRight(cfg.PublicURL, "/"),
		webhookURL: cfg.AlertWebhookURL, webhookSecret: cfg.AlertWebhookSecret,
		discordURL: cfg.DiscordWebhookURL, now: time.Now,
	}
}

func (r *Runner) Run(ctx context.Context) {
	if err := r.store.ReconcileAlertDeliveries(ctx); err != nil && ctx.Err() == nil {
		r.logger.Error("reconcile alert deliveries", "error", err)
	}
	poll := time.NewTicker(pollInterval)
	reconcile := time.NewTicker(reconcileEvery)
	defer poll.Stop()
	defer reconcile.Stop()
	for {
		r.process(ctx)
		select {
		case <-ctx.Done():
			return
		case <-reconcile.C:
			if err := r.store.ReconcileAlertDeliveries(ctx); err != nil && ctx.Err() == nil {
				r.logger.Error("reconcile alert deliveries", "error", err)
			}
		case <-poll.C:
		}
	}
}

func (r *Runner) process(ctx context.Context) {
	deliveries, err := r.store.ClaimAlertDeliveries(ctx, r.owner, claimLease, claimBatch)
	if err != nil {
		if ctx.Err() == nil {
			r.logger.Error("claim alert deliveries", "error", err)
		}
		return
	}
	var group sync.WaitGroup
	for _, delivery := range deliveries {
		delivery := delivery
		group.Add(1)
		go func() {
			defer group.Done()
			r.deliver(ctx, delivery)
		}()
	}
	group.Wait()
}

func (r *Runner) deliver(ctx context.Context, delivery store.AlertDelivery) {
	started := time.Now()
	response, err := r.send(ctx, delivery)
	r.metrics.AlertDeliveryDuration.WithLabelValues(delivery.Channel).Observe(time.Since(started).Seconds())
	if err == nil && response.statusCode >= 200 && response.statusCode < 300 {
		if err := r.store.CompleteAlertDelivery(ctx, delivery.ID, r.owner); err != nil {
			r.logger.Error("complete alert delivery", "delivery", delivery.String(), "error", err)
			return
		}
		r.metrics.AlertDeliveries.WithLabelValues(delivery.Channel, "delivered").Inc()
		r.logger.Info("alert delivered", "delivery", delivery.String(), "attempt", delivery.Attempt)
		return
	}

	statusCode := 0
	message := "delivery request failed"
	permanent := false
	retryAt := r.now().Add(retryDelay(delivery.Attempt))
	if err != nil {
		message = err.Error()
	} else {
		statusCode = response.statusCode
		message = response.message
		permanent = !retryableStatus(response.statusCode)
		if retryAfter, ok := parseRetryAfter(response.retryAfter, r.now()); ok {
			retryAt = retryAfter
		}
	}
	state, storeErr := r.store.FailAlertDelivery(ctx, delivery.ID, r.owner, delivery.Attempt,
		maxAttempts, retryAt, statusCode, message, permanent)
	if storeErr != nil {
		r.logger.Error("record alert delivery failure", "delivery", delivery.String(), "error", storeErr)
		return
	}
	outcome := "retry"
	if state == "failed" {
		outcome = "failed"
	}
	r.metrics.AlertDeliveries.WithLabelValues(delivery.Channel, outcome).Inc()
	r.logger.Warn("alert delivery unsuccessful", "delivery", delivery.String(), "attempt", delivery.Attempt,
		"status", statusCode, "outcome", outcome, "error", message)
}

type deliveryResponse struct {
	statusCode int
	retryAfter string
	message    string
}

func (r *Runner) send(ctx context.Context, delivery store.AlertDelivery) (deliveryResponse, error) {
	var request *http.Request
	var err error
	switch delivery.Channel {
	case "webhook":
		request, err = r.webhookRequest(ctx, delivery)
	case "discord":
		request, err = r.discordRequest(ctx, delivery)
	default:
		return deliveryResponse{}, fmt.Errorf("unsupported alert channel %q", delivery.Channel)
	}
	if err != nil {
		return deliveryResponse{}, err
	}
	response, err := r.client.Do(request)
	if err != nil {
		return deliveryResponse{}, err
	}
	defer response.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(response.Body, 4096))
	message := strings.TrimSpace(string(body))
	if len(message) > 500 {
		message = message[:500]
	}
	if message == "" {
		message = response.Status
	}
	return deliveryResponse{statusCode: response.StatusCode, retryAfter: response.Header.Get("Retry-After"), message: message}, nil
}

type webhookPayload struct {
	SchemaVersion int                `json:"schemaVersion"`
	Event         string             `json:"event"`
	ID            uuid.UUID          `json:"id"`
	DeliveryID    uuid.UUID          `json:"deliveryId"`
	OccurredAt    time.Time          `json:"occurredAt"`
	Monitor       webhookMonitor     `json:"monitor"`
	Observation   webhookObservation `json:"observation"`
	EvidenceURL   string             `json:"evidenceUrl"`
}

type webhookMonitor struct {
	ID     uuid.UUID `json:"id"`
	URL    string    `json:"url"`
	Intent string    `json:"intent"`
}

type webhookObservation struct {
	ID          uuid.UUID `json:"id"`
	ExecutionID uuid.UUID `json:"executionId"`
	PriceMinor  int64     `json:"priceMinor"`
	Currency    string    `json:"currency"`
	InStock     bool      `json:"inStock"`
	Title       string    `json:"title"`
	ObservedAt  time.Time `json:"observedAt"`
}

func (r *Runner) webhookRequest(ctx context.Context, delivery store.AlertDelivery) (*http.Request, error) {
	payload := webhookPayload{
		SchemaVersion: 1, Event: "price.condition_met", ID: delivery.AlertID,
		DeliveryID: delivery.ID, OccurredAt: delivery.AlertCreatedAt,
		Monitor: webhookMonitor{ID: delivery.MonitorID, URL: delivery.MonitorURL, Intent: delivery.MonitorIntent},
		Observation: webhookObservation{ID: delivery.ObservationID, ExecutionID: delivery.ExecutionID,
			PriceMinor: delivery.PriceMinor, Currency: delivery.Currency, InStock: delivery.InStock,
			Title: delivery.Title, ObservedAt: delivery.ObservationTime},
		EvidenceURL: r.publicURL + "/executions/" + delivery.ExecutionID.String(),
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return nil, err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, r.webhookURL, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	timestamp := strconv.FormatInt(r.now().Unix(), 10)
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("User-Agent", "price-scout/0.1")
	request.Header.Set("Idempotency-Key", delivery.ID.String())
	request.Header.Set("X-Price-Scout-Delivery", delivery.ID.String())
	request.Header.Set("X-Price-Scout-Timestamp", timestamp)
	request.Header.Set("X-Price-Scout-Signature", sign(r.webhookSecret, timestamp, body))
	return request, nil
}

func (r *Runner) discordRequest(ctx context.Context, delivery store.AlertDelivery) (*http.Request, error) {
	endpoint, err := url.Parse(r.discordURL)
	if err != nil {
		return nil, err
	}
	query := endpoint.Query()
	query.Set("wait", "true")
	endpoint.RawQuery = query.Encode()
	payload := map[string]any{
		"username":         "Price Scout",
		"allowed_mentions": map[string]any{"parse": []string{}},
		"nonce":            discordNonce(delivery.ID),
		"enforce_nonce":    true,
		"embeds": []any{map[string]any{
			"title":       "Price target reached",
			"description": truncateDiscord(escapeMarkdown(delivery.Title), 500),
			"url":         delivery.MonitorURL,
			"color":       0x22c55e,
			"fields": []any{
				map[string]any{"name": "Observed price", "value": formatMoney(delivery.PriceMinor, delivery.Currency), "inline": true},
				map[string]any{"name": "Availability", "value": map[bool]string{true: "In stock", false: "Out of stock"}[delivery.InStock], "inline": true},
				map[string]any{"name": "Monitor", "value": truncateDiscord(escapeMarkdown(delivery.MonitorIntent), 500), "inline": false},
				map[string]any{"name": "Evidence", "value": r.publicURL + "/executions/" + delivery.ExecutionID.String(), "inline": false},
			},
			"timestamp": delivery.ObservationTime.UTC().Format(time.RFC3339),
			"footer":    map[string]any{"text": "Alert " + delivery.AlertID.String()},
		}},
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return nil, err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint.String(), bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("User-Agent", "price-scout/0.1")
	request.Header.Set("Idempotency-Key", delivery.ID.String())
	return request, nil
}

func sign(secret, timestamp string, body []byte) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(timestamp))
	mac.Write([]byte("."))
	mac.Write(body)
	return "sha256=" + hex.EncodeToString(mac.Sum(nil))
}

func discordNonce(id uuid.UUID) string {
	// Discord limits nonce values to 25 characters. Twenty-five UUID hex
	// characters retain 100 bits while remaining stable across retries.
	return strings.ReplaceAll(id.String(), "-", "")[:25]
}

func retryableStatus(status int) bool {
	return status == http.StatusRequestTimeout || status == http.StatusTooEarly ||
		status == http.StatusTooManyRequests || status >= 500
}

func retryDelay(attempt int) time.Duration {
	if attempt < 1 {
		attempt = 1
	}
	delay := 5 * time.Second * time.Duration(1<<min(attempt-1, 8))
	return min(delay, 15*time.Minute)
}

func parseRetryAfter(raw string, now time.Time) (time.Time, bool) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return time.Time{}, false
	}
	if seconds, err := strconv.Atoi(raw); err == nil {
		seconds = max(1, min(seconds, 3600))
		return now.Add(time.Duration(seconds) * time.Second), true
	}
	when, err := http.ParseTime(raw)
	if err != nil {
		return time.Time{}, false
	}
	if when.Before(now.Add(time.Second)) {
		when = now.Add(time.Second)
	}
	if when.After(now.Add(time.Hour)) {
		when = now.Add(time.Hour)
	}
	return when, true
}

func formatMoney(minor int64, currency string) string {
	digits := minorDigits(strings.ToUpper(currency))
	sign := ""
	if minor < 0 {
		sign = "-"
		minor = -minor
	}
	if digits == 0 {
		return fmt.Sprintf("%s%s %d", sign, strings.ToUpper(currency), minor)
	}
	divisor := int64(1)
	for range digits {
		divisor *= 10
	}
	return fmt.Sprintf("%s%s %d.%0*d", sign, strings.ToUpper(currency), minor/divisor, digits, minor%divisor)
}

func minorDigits(currency string) int {
	switch currency {
	case "BIF", "CLP", "DJF", "GNF", "ISK", "JPY", "KMF", "KRW", "PYG", "RWF", "UGX", "UYI", "VND", "VUV", "XAF", "XOF", "XPF":
		return 0
	case "BHD", "IQD", "JOD", "KWD", "LYD", "OMR", "TND":
		return 3
	case "CLF", "UYW":
		return 4
	default:
		return 2
	}
}

func escapeMarkdown(value string) string {
	replacer := strings.NewReplacer("\\", "\\\\", "*", "\\*", "_", "\\_", "~", "\\~", "`", "\\`", "|", "\\|", ">", "\\>", "[", "\\[", "]", "\\]", "(", "\\(", ")", "\\)")
	return replacer.Replace(value)
}

func truncateDiscord(value string, limit int) string {
	if utf8.RuneCountInString(value) <= limit {
		return value
	}
	runes := []rune(value)
	return string(runes[:limit-1]) + "…"
}
