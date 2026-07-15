package store

import (
	"testing"

	"github.com/nmhossain02/price-scout/internal/domain"
)

func TestRecoveryDecisionIsBounded(t *testing.T) {
	if got := recoveryDecision(1, 3); got != RecoveryRequeued {
		t.Fatalf("attempt 1 outcome = %q", got)
	}
	if got := recoveryDecision(3, 3); got != RecoveryTerminal {
		t.Fatalf("attempt 3 outcome = %q", got)
	}
}

func TestRecoverySubjectPreservesExecutionKind(t *testing.T) {
	for _, kind := range []domain.ExecutionKind{domain.ExecutionCompile, domain.ExecutionCheck, domain.ExecutionRepair} {
		if got, want := recoverySubject(kind), "scout.monitor."+string(kind); got != want {
			t.Fatalf("recoverySubject(%s) = %q, want %q", kind, got, want)
		}
	}
}

func TestTransientCompileAndRepairRetriesAreBounded(t *testing.T) {
	tests := []struct {
		name      string
		execution domain.Execution
		result    domain.ExecutionResult
		want      bool
	}{
		{
			name:      "compile transient",
			execution: domain.Execution{Kind: domain.ExecutionCompile, Attempt: 1},
			result:    domain.ExecutionResult{Status: "failed", FailureClassification: "transient_infrastructure"},
			want:      true,
		},
		{
			name:      "repair rate limited",
			execution: domain.Execution{Kind: domain.ExecutionRepair, Attempt: 2},
			result:    domain.ExecutionResult{Status: "failed", FailureClassification: "rate_limited"},
			want:      true,
		},
		{
			name:      "attempt limit",
			execution: domain.Execution{Kind: domain.ExecutionCompile, Attempt: 3},
			result:    domain.ExecutionResult{Status: "failed", FailureClassification: "transient_infrastructure"},
		},
		{
			name:      "routine check",
			execution: domain.Execution{Kind: domain.ExecutionCheck, Attempt: 1},
			result:    domain.ExecutionResult{Status: "failed", FailureClassification: "transient_infrastructure"},
		},
		{
			name:      "semantic failure",
			execution: domain.Execution{Kind: domain.ExecutionRepair, Attempt: 1},
			result:    domain.ExecutionResult{Status: "failed", FailureClassification: "ambiguous_value"},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := shouldRetryExecutionResult(test.execution, test.result, 3); got != test.want {
				t.Fatalf("shouldRetryExecutionResult() = %v, want %v", got, test.want)
			}
		})
	}
}
