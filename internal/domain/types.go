package domain

import (
	"encoding/json"
	"time"

	"github.com/google/uuid"
)

const SchemaVersion = 1

type MonitorStatus string

const (
	MonitorCompiling            MonitorStatus = "compiling"
	MonitorAwaitingConfirmation MonitorStatus = "awaiting_confirmation"
	MonitorActive               MonitorStatus = "active"
	MonitorNeedsReview          MonitorStatus = "needs_review"
	MonitorPaused               MonitorStatus = "paused"
	MonitorBlocked              MonitorStatus = "blocked"
)

type ExecutionKind string

const (
	ExecutionCompile ExecutionKind = "compile"
	ExecutionCheck   ExecutionKind = "check"
	ExecutionRepair  ExecutionKind = "repair"
)

type Monitor struct {
	ID                uuid.UUID       `json:"id"`
	URL               string          `json:"url"`
	Intent            string          `json:"intent"`
	IntervalMinutes   int             `json:"intervalMinutes"`
	Condition         json.RawMessage `json:"condition,omitempty"`
	Status            MonitorStatus   `json:"status"`
	CurrentRevisionID *uuid.UUID      `json:"currentRevisionId,omitempty"`
	ConditionMatched  bool            `json:"conditionMatched"`
	NextRunAt         *time.Time      `json:"nextRunAt,omitempty"`
	CreatedAt         time.Time       `json:"createdAt"`
	UpdatedAt         time.Time       `json:"updatedAt"`
}

// MonitorSummary is the dashboard/list representation. It keeps the monitor
// resource stable while adding the most recent observation without loading the
// full revision and execution history used by MonitorDetail.
type MonitorSummary struct {
	Monitor
	LatestObservation *Observation `json:"latestObservation,omitempty"`
}

type Revision struct {
	ID              uuid.UUID       `json:"id"`
	MonitorID       uuid.UUID       `json:"monitorId"`
	Generation      int             `json:"generation"`
	Plan            json.RawMessage `json:"plan"`
	Source          string          `json:"source"`
	ValidationState string          `json:"validationState"`
	ActivatedAt     *time.Time      `json:"activatedAt,omitempty"`
	CreatedAt       time.Time       `json:"createdAt"`
}

type Execution struct {
	ID                    uuid.UUID       `json:"id"`
	MonitorID             uuid.UUID       `json:"monitorId"`
	RevisionID            *uuid.UUID      `json:"revisionId,omitempty"`
	Kind                  ExecutionKind   `json:"kind"`
	RequestedGeneration   *int            `json:"requestedGeneration,omitempty"`
	Attempt               int             `json:"attempt"`
	RecoveryOf            *uuid.UUID      `json:"recoveryOf,omitempty"`
	State                 string          `json:"state"`
	FailureClassification *string         `json:"failureClassification,omitempty"`
	Provider              *string         `json:"provider,omitempty"`
	TraceID               *string         `json:"traceId,omitempty"`
	BrowserSessionURL     *string         `json:"browserSessionUrl,omitempty"`
	Input                 json.RawMessage `json:"input,omitempty"`
	Result                json.RawMessage `json:"result,omitempty"`
	Error                 *string         `json:"error,omitempty"`
	CreatedAt             time.Time       `json:"createdAt"`
	StartedAt             *time.Time      `json:"startedAt,omitempty"`
	CompletedAt           *time.Time      `json:"completedAt,omitempty"`
}

type Observation struct {
	ID             uuid.UUID       `json:"id"`
	MonitorID      uuid.UUID       `json:"monitorId"`
	ExecutionID    uuid.UUID       `json:"executionId"`
	PriceMinor     int64           `json:"priceMinor"`
	Currency       string          `json:"currency"`
	InStock        bool            `json:"inStock"`
	Title          string          `json:"title"`
	RawText        string          `json:"rawText,omitempty"`
	Identity       json.RawMessage `json:"identity,omitempty"`
	Verification   string          `json:"verificationState"`
	ConditionMatch bool            `json:"conditionMatched"`
	ObservedAt     time.Time       `json:"observedAt"`
}

type Artifact struct {
	ID          uuid.UUID `json:"id"`
	ExecutionID uuid.UUID `json:"executionId"`
	Kind        string    `json:"kind"`
	StorageKey  string    `json:"storageKey"`
	ContentType string    `json:"contentType"`
	SHA256      string    `json:"sha256,omitempty"`
	SizeBytes   int64     `json:"sizeBytes,omitempty"`
	CreatedAt   time.Time `json:"createdAt"`
	URL         string    `json:"url,omitempty"`
}

type ExecutionDetail struct {
	Execution
	Observation *Observation `json:"observation,omitempty"`
	Artifacts   []Artifact   `json:"artifacts"`
}

type WorkMessage struct {
	SchemaVersion int        `json:"schemaVersion"`
	ExecutionID   uuid.UUID  `json:"executionId"`
	MonitorID     uuid.UUID  `json:"monitorId"`
	RevisionID    *uuid.UUID `json:"revisionId,omitempty"`
	Traceparent   string     `json:"traceparent,omitempty"`
}

type ExecutionInput struct {
	SchemaVersion int             `json:"schemaVersion"`
	Execution     Execution       `json:"execution"`
	Monitor       Monitor         `json:"monitor"`
	Revision      *Revision       `json:"revision,omitempty"`
	Plan          json.RawMessage `json:"plan,omitempty"`
}

type ResultArtifact struct {
	Kind        string `json:"kind"`
	StorageKey  string `json:"storageKey"`
	ContentType string `json:"contentType"`
	SHA256      string `json:"sha256,omitempty"`
	SizeBytes   int64  `json:"sizeBytes,omitempty"`
}

type ResultObservation struct {
	PriceMinor        int64           `json:"priceMinor"`
	Currency          string          `json:"currency"`
	InStock           bool            `json:"inStock"`
	Title             string          `json:"title"`
	RawText           string          `json:"rawText,omitempty"`
	Identity          json.RawMessage `json:"identity,omitempty"`
	VerificationState string          `json:"verificationState,omitempty"`
	ConditionMatched  *bool           `json:"conditionMatched,omitempty"`
}

type ExecutionResult struct {
	Status                string             `json:"status"`
	FailureClassification string             `json:"failureClassification,omitempty"`
	Error                 string             `json:"error,omitempty"`
	Provider              string             `json:"provider,omitempty"`
	TraceID               string             `json:"traceId,omitempty"`
	BrowserSessionURL     string             `json:"browserSessionUrl,omitempty"`
	Plan                  json.RawMessage    `json:"plan,omitempty"`
	Observation           *ResultObservation `json:"observation,omitempty"`
	Artifacts             []ResultArtifact   `json:"artifacts,omitempty"`
	AutoPromote           bool               `json:"autoPromote,omitempty"`
	Diagnostics           json.RawMessage    `json:"diagnostics,omitempty"`
}

type MonitorDetail struct {
	Monitor      Monitor       `json:"monitor"`
	Revisions    []Revision    `json:"revisions"`
	Executions   []Execution   `json:"executions"`
	Observations []Observation `json:"observations"`
}
