package store

import (
	"encoding/json"
	"testing"

	"github.com/nmhossain02/price-scout/internal/domain"
)

func TestMatchesCondition(t *testing.T) {
	threshold := json.RawMessage(`{"priceBelowMinor":13000,"currency":"USD","requireInStock":true}`)
	tests := []struct {
		name        string
		observation domain.ResultObservation
		want        bool
	}{
		{name: "matching price and stock", observation: domain.ResultObservation{PriceMinor: 12999, Currency: "usd", InStock: true}, want: true},
		{name: "strict below boundary is excluded", observation: domain.ResultObservation{PriceMinor: 13000, Currency: "USD", InStock: true}},
		{name: "price is too high", observation: domain.ResultObservation{PriceMinor: 13001, Currency: "USD", InStock: true}},
		{name: "wrong currency", observation: domain.ResultObservation{PriceMinor: 12000, Currency: "CAD", InStock: true}},
		{name: "out of stock", observation: domain.ResultObservation{PriceMinor: 12000, Currency: "USD", InStock: false}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := MatchesCondition(threshold, test.observation); got != test.want {
				t.Fatalf("MatchesCondition() = %v, want %v", got, test.want)
			}
		})
	}
}

func TestMatchesConditionAcceptsLegacyThreshold(t *testing.T) {
	condition := json.RawMessage(`{"maxPriceMinor":5000}`)
	if !MatchesCondition(condition, domain.ResultObservation{PriceMinor: 5000}) {
		t.Fatal("legacy maxPriceMinor should remain inclusive at its boundary")
	}
}

func TestMatchesConditionRejectsUnboundedCondition(t *testing.T) {
	if MatchesCondition(json.RawMessage(`{"requireInStock":true}`), domain.ResultObservation{PriceMinor: 1, InStock: true}) {
		t.Fatal("a condition without a threshold must not match")
	}
}

func TestExecutionIsAlertConfirmation(t *testing.T) {
	if !executionIsAlertConfirmation(domain.Execution{Input: json.RawMessage(`{"alertConfirmation":true}`)}) {
		t.Fatal("expected alert confirmation input to be recognized")
	}
	if executionIsAlertConfirmation(domain.Execution{Input: json.RawMessage(`{}`)}) {
		t.Fatal("ordinary checks must not be treated as confirmations")
	}
}
