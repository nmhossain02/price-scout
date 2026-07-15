-- +goose Up
CREATE TABLE alert_deliveries (
    id uuid PRIMARY KEY,
    alert_id uuid NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
    channel text NOT NULL CHECK (channel IN ('webhook','discord')),
    state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','leased','delivered','failed')),
    attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    next_attempt_at timestamptz NOT NULL DEFAULT now(),
    lease_owner uuid,
    lease_expires_at timestamptz,
    last_error text,
    last_status_code integer,
    delivered_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (alert_id, channel),
    CHECK ((state = 'leased') = (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL))
);

CREATE INDEX alert_deliveries_due_idx
    ON alert_deliveries (next_attempt_at, id)
    WHERE state IN ('pending','leased');

ALTER TABLE alerts ALTER COLUMN delivery_state SET DEFAULT 'unconfigured';
UPDATE alerts SET delivery_state='unconfigured' WHERE delivery_state='pending';

-- +goose Down
DROP TABLE alert_deliveries;
ALTER TABLE alerts ALTER COLUMN delivery_state SET DEFAULT 'pending';
UPDATE alerts SET delivery_state='pending' WHERE delivery_state='unconfigured';
