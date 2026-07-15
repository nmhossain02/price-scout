package store

import (
	"encoding/json"
	"errors"
	"testing"

	"github.com/nmhossain02/price-scout/internal/domain"
)

func TestValidateResult(t *testing.T) {
	tests := []struct {
		name      string
		execution domain.Execution
		result    domain.ExecutionResult
		wantError bool
	}{
		{name: "compile plan", execution: domain.Execution{Kind: domain.ExecutionCompile}, result: domain.ExecutionResult{Status: "succeeded", Plan: json.RawMessage(`{"schemaVersion":1}`)}},
		{name: "compile without plan", execution: domain.Execution{Kind: domain.ExecutionCompile}, result: domain.ExecutionResult{Status: "succeeded"}, wantError: true},
		{name: "check observation", execution: domain.Execution{Kind: domain.ExecutionCheck}, result: domain.ExecutionResult{Status: "succeeded", Observation: &domain.ResultObservation{PriceMinor: 1}}},
		{name: "check without observation", execution: domain.Execution{Kind: domain.ExecutionCheck}, result: domain.ExecutionResult{Status: "succeeded"}, wantError: true},
		{name: "classified failure", execution: domain.Execution{Kind: domain.ExecutionCheck}, result: domain.ExecutionResult{Status: "failed", FailureClassification: "stale_action"}},
		{name: "unexplained failure", execution: domain.Execution{Kind: domain.ExecutionCheck}, result: domain.ExecutionResult{Status: "failed"}, wantError: true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			err := validateResult(test.execution, test.result)
			if test.wantError && !errors.Is(err, ErrInvalidResult) {
				t.Fatalf("validateResult() error = %v", err)
			}
			if !test.wantError && err != nil {
				t.Fatalf("validateResult() unexpected error = %v", err)
			}
		})
	}
}
