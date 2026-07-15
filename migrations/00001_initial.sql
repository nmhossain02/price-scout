-- +goose Up
CREATE TABLE monitors (
    id uuid PRIMARY KEY,
    url text NOT NULL,
    intent text NOT NULL,
    interval_minutes integer NOT NULL CHECK (interval_minutes >= 1),
    condition jsonb NOT NULL DEFAULT '{}'::jsonb,
    status text NOT NULL CHECK (status IN ('compiling','awaiting_confirmation','active','needs_review','paused','blocked')),
    current_revision_id uuid,
    condition_matched boolean NOT NULL DEFAULT false,
    next_run_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE monitor_revisions (
    id uuid PRIMARY KEY,
    monitor_id uuid NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
    generation integer NOT NULL CHECK (generation > 0),
    plan jsonb NOT NULL,
    source text NOT NULL CHECK (source IN ('compile','repair','manual')),
    validation_state text NOT NULL CHECK (validation_state IN ('candidate','awaiting_confirmation','active','rejected')),
    activated_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (monitor_id, generation)
);

ALTER TABLE monitors ADD CONSTRAINT monitors_current_revision_fk
    FOREIGN KEY (current_revision_id) REFERENCES monitor_revisions(id);

CREATE TABLE executions (
    id uuid PRIMARY KEY,
    monitor_id uuid NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
    revision_id uuid REFERENCES monitor_revisions(id),
    kind text NOT NULL CHECK (kind IN ('compile','check','repair')),
    requested_generation integer,
    attempt integer NOT NULL DEFAULT 1,
    state text NOT NULL CHECK (state IN ('queued','running','succeeded','failed','blocked','needs_review')),
    failure_classification text,
    provider text,
    trace_id text,
    browser_session_url text,
    input jsonb NOT NULL DEFAULT '{}'::jsonb,
    result jsonb,
    error text,
    idempotency_key text,
    created_at timestamptz NOT NULL DEFAULT now(),
    started_at timestamptz,
    completed_at timestamptz,
    UNIQUE (monitor_id, idempotency_key)
);

CREATE INDEX executions_monitor_created_idx ON executions (monitor_id, created_at DESC);
CREATE INDEX executions_state_idx ON executions (state, created_at);

CREATE TABLE observations (
    id uuid PRIMARY KEY,
    monitor_id uuid NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
    execution_id uuid NOT NULL UNIQUE REFERENCES executions(id) ON DELETE CASCADE,
    price_minor bigint NOT NULL CHECK (price_minor > 0),
    currency varchar(3) NOT NULL,
    in_stock boolean NOT NULL,
    title text NOT NULL,
    raw_text text,
    identity jsonb NOT NULL DEFAULT '{}'::jsonb,
    verification_state text NOT NULL CHECK (verification_state IN ('verified','review_required','failed','blocked')),
    condition_matched boolean NOT NULL DEFAULT false,
    observed_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX observations_monitor_time_idx ON observations (monitor_id, observed_at DESC);

CREATE TABLE repair_attempts (
    id uuid PRIMARY KEY,
    monitor_id uuid NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
    failed_generation integer NOT NULL,
    execution_id uuid NOT NULL UNIQUE REFERENCES executions(id) ON DELETE CASCADE,
    candidate_revision_id uuid REFERENCES monitor_revisions(id),
    state text NOT NULL CHECK (state IN ('queued','running','candidate','activated','rejected','failed')),
    outcome text,
    created_at timestamptz NOT NULL DEFAULT now(),
    completed_at timestamptz,
    UNIQUE (monitor_id, failed_generation)
);

CREATE TABLE alerts (
    id uuid PRIMARY KEY,
    monitor_id uuid NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
    observation_id uuid NOT NULL REFERENCES observations(id) ON DELETE CASCADE,
    transition text NOT NULL DEFAULT 'false_to_true',
    channel text NOT NULL DEFAULT 'webhook',
    idempotency_key text NOT NULL UNIQUE,
    delivery_state text NOT NULL DEFAULT 'pending',
    created_at timestamptz NOT NULL DEFAULT now(),
    delivered_at timestamptz
);

CREATE TABLE artifacts (
    id uuid PRIMARY KEY,
    execution_id uuid NOT NULL REFERENCES executions(id) ON DELETE CASCADE,
    kind text NOT NULL,
    storage_key text NOT NULL,
    content_type text NOT NULL,
    sha256 text,
    size_bytes bigint,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (execution_id, storage_key)
);

CREATE TABLE outbox (
    id bigserial PRIMARY KEY,
    subject text NOT NULL,
    payload jsonb NOT NULL,
    published_at timestamptz,
    attempts integer NOT NULL DEFAULT 0,
    last_error text,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX outbox_unpublished_idx ON outbox (id) WHERE published_at IS NULL;
CREATE INDEX monitors_due_idx ON monitors (next_run_at) WHERE status = 'active';

-- +goose Down
DROP TABLE outbox;
DROP TABLE artifacts;
DROP TABLE alerts;
DROP TABLE repair_attempts;
DROP TABLE observations;
DROP TABLE executions;
ALTER TABLE monitors DROP CONSTRAINT monitors_current_revision_fk;
DROP TABLE monitor_revisions;
DROP TABLE monitors;
