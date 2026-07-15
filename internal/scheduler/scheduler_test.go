package scheduler

import (
	"testing"

	"github.com/google/uuid"
	"github.com/nmhossain02/price-scout/internal/domain"
	"github.com/nmhossain02/price-scout/internal/metrics"
	"github.com/nmhossain02/price-scout/internal/store"
)

func TestRecordExecutionRecoveriesPublishesBoundedOutcomeMetrics(t *testing.T) {
	telemetry := metrics.New()
	recordExecutionRecoveries(telemetry, []store.ExecutionRecovery{
		{ExecutionID: uuid.New(), Kind: domain.ExecutionCheck, PriorState: "running", Outcome: store.RecoveryRequeued, Attempt: 1},
		{ExecutionID: uuid.New(), Kind: domain.ExecutionRepair, PriorState: "running", Outcome: store.RecoveryTerminal, Attempt: 3},
	})

	if got := gatheredCounter(t, telemetry, "scout_execution_recoveries_total", map[string]string{
		"kind": "check", "outcome": "requeued", "prior_state": "running",
	}); got != 1 {
		t.Fatalf("requeued recovery metric = %v, want 1", got)
	}
	if got := gatheredCounter(t, telemetry, "scout_execution_recoveries_total", map[string]string{
		"kind": "repair", "outcome": "terminal", "prior_state": "running",
	}); got != 1 {
		t.Fatalf("terminal recovery metric = %v, want 1", got)
	}
}

func gatheredCounter(t *testing.T, telemetry *metrics.Metrics, name string, labels map[string]string) float64 {
	t.Helper()
	families, err := telemetry.Registry.Gather()
	if err != nil {
		t.Fatal(err)
	}
	for _, family := range families {
		if family.GetName() != name {
			continue
		}
		for _, metric := range family.Metric {
			matched := true
			for key, want := range labels {
				found := false
				for _, pair := range metric.Label {
					if pair.GetName() == key && pair.GetValue() == want {
						found = true
						break
					}
				}
				matched = matched && found
			}
			if matched {
				return metric.GetCounter().GetValue()
			}
		}
	}
	t.Fatalf("metric %s with labels %v was not gathered", name, labels)
	return 0
}
