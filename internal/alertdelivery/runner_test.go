package alertdelivery

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/nmhossain02/price-scout/internal/store"
)

func testDelivery() store.AlertDelivery {
	return store.AlertDelivery{
		ID:      uuid.MustParse("10000000-0000-0000-0000-000000000001"),
		AlertID: uuid.MustParse("20000000-0000-0000-0000-000000000002"),
		Channel: "webhook", Attempt: 1,
		AlertCreatedAt: time.Date(2026, 7, 14, 12, 0, 0, 0, time.UTC),
		MonitorID:      uuid.MustParse("30000000-0000-0000-0000-000000000003"),
		MonitorURL:     "https://shop.example/product", MonitorIntent: "below $130",
		ObservationID: uuid.MustParse("40000000-0000-0000-0000-000000000004"),
		ExecutionID:   uuid.MustParse("50000000-0000-0000-0000-000000000005"),
		PriceMinor:    12900, Currency: "USD", InStock: true, Title: "Aurora *Headphones* @everyone",
		ObservationTime: time.Date(2026, 7, 14, 11, 59, 0, 0, time.UTC),
	}
}

func TestWebhookRequestIsSignedAndIdempotent(t *testing.T) {
	fixed := time.Date(2026, 7, 14, 12, 1, 0, 0, time.UTC)
	runner := &Runner{
		publicURL: "http://127.0.0.1:3000", webhookURL: "https://hooks.example/scout",
		webhookSecret: "test-secret", now: func() time.Time { return fixed },
	}
	delivery := testDelivery()
	request, err := runner.webhookRequest(context.Background(), delivery)
	if err != nil {
		t.Fatal(err)
	}
	body, err := io.ReadAll(request.Body)
	if err != nil {
		t.Fatal(err)
	}
	if request.Header.Get("Idempotency-Key") != delivery.ID.String() {
		t.Fatal("delivery ID was not used as the idempotency key")
	}
	timestamp := request.Header.Get("X-Price-Scout-Timestamp")
	mac := hmac.New(sha256.New, []byte("test-secret"))
	mac.Write([]byte(timestamp + "."))
	mac.Write(body)
	wantSignature := "sha256=" + hex.EncodeToString(mac.Sum(nil))
	if request.Header.Get("X-Price-Scout-Signature") != wantSignature {
		t.Fatal("webhook signature did not cover timestamp and exact body")
	}
	var payload webhookPayload
	if err := json.Unmarshal(body, &payload); err != nil {
		t.Fatal(err)
	}
	if payload.Event != "price.condition_met" || !strings.HasSuffix(payload.EvidenceURL, delivery.ExecutionID.String()) {
		t.Fatalf("unexpected webhook payload: %+v", payload)
	}
}

func TestDiscordRequestDisablesMentionsAndUsesNonce(t *testing.T) {
	runner := &Runner{
		publicURL:  "http://127.0.0.1:3000",
		discordURL: "https://discord.example/webhook?thread_id=7",
	}
	delivery := testDelivery()
	delivery.Channel = "discord"
	request, err := runner.discordRequest(context.Background(), delivery)
	if err != nil {
		t.Fatal(err)
	}
	if request.URL.Query().Get("wait") != "true" || request.URL.Query().Get("thread_id") != "7" {
		t.Fatalf("discord query was not preserved: %s", request.URL)
	}
	var payload struct {
		AllowedMentions struct {
			Parse []string `json:"parse"`
		} `json:"allowed_mentions"`
		Nonce        string `json:"nonce"`
		EnforceNonce bool   `json:"enforce_nonce"`
		Embeds       []struct {
			Description string `json:"description"`
		} `json:"embeds"`
	}
	if err := json.NewDecoder(request.Body).Decode(&payload); err != nil {
		t.Fatal(err)
	}
	if len(payload.AllowedMentions.Parse) != 0 || payload.Nonce != discordNonce(delivery.ID) || len(payload.Nonce) > 25 || !payload.EnforceNonce {
		t.Fatalf("unsafe or non-idempotent Discord payload: %+v", payload)
	}
	if !strings.Contains(payload.Embeds[0].Description, `\*Headphones\*`) {
		t.Fatalf("retailer-controlled markdown was not escaped: %q", payload.Embeds[0].Description)
	}
}

func TestRetryPolicyIsBounded(t *testing.T) {
	if retryDelay(1) != 5*time.Second || retryDelay(20) != 15*time.Minute {
		t.Fatalf("unexpected retry bounds: %s, %s", retryDelay(1), retryDelay(20))
	}
	if !retryableStatus(http.StatusTooManyRequests) || !retryableStatus(http.StatusBadGateway) || retryableStatus(http.StatusBadRequest) {
		t.Fatal("HTTP retry classification is incorrect")
	}
	now := time.Date(2026, 7, 14, 12, 0, 0, 0, time.UTC)
	when, ok := parseRetryAfter("7200", now)
	if !ok || !when.Equal(now.Add(time.Hour)) {
		t.Fatalf("Retry-After was not capped: %s", when)
	}
}

func TestFormatMoneyUsesISOMinorUnits(t *testing.T) {
	for _, test := range []struct {
		minor    int64
		currency string
		want     string
	}{
		{12900, "USD", "USD 129.00"},
		{129, "JPY", "JPY 129"},
		{12900, "KWD", "KWD 12.900"},
	} {
		if got := formatMoney(test.minor, test.currency); got != test.want {
			t.Fatalf("formatMoney(%d,%s) = %q, want %q", test.minor, test.currency, got, test.want)
		}
	}
}
