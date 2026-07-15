package store

import (
	"testing"
	"time"
)

func TestDecodeLatestObservation(t *testing.T) {
	observedAt := "2026-07-14T12:00:00Z"
	raw := []byte(`{
        "id":"40000000-0000-0000-0000-000000000004",
        "monitorId":"30000000-0000-0000-0000-000000000003",
        "executionId":"50000000-0000-0000-0000-000000000005",
        "priceMinor":12900,
        "currency":"USD",
        "inStock":true,
        "title":"Aurora Headphones",
        "identity":{},
        "verificationState":"verified",
        "conditionMatched":true,
        "observedAt":"` + observedAt + `"
    }`)
	observation, err := decodeLatestObservation(raw)
	if err != nil {
		t.Fatal(err)
	}
	if observation == nil || observation.PriceMinor != 12900 || observation.Currency != "USD" || !observation.InStock {
		t.Fatalf("unexpected latest observation: %+v", observation)
	}
	wantTime, _ := time.Parse(time.RFC3339, observedAt)
	if !observation.ObservedAt.Equal(wantTime) {
		t.Fatalf("observedAt = %s, want %s", observation.ObservedAt, wantTime)
	}
}

func TestDecodeLatestObservationAllowsMissingObservation(t *testing.T) {
	for _, raw := range [][]byte{nil, []byte("null")} {
		observation, err := decodeLatestObservation(raw)
		if err != nil || observation != nil {
			t.Fatalf("decodeLatestObservation(%q) = %+v, %v", raw, observation, err)
		}
	}
}
