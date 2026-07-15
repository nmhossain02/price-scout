-- +goose Up
ALTER TABLE executions ADD COLUMN recovery_of uuid;
ALTER TABLE executions ADD CONSTRAINT executions_recovery_of_fk
    FOREIGN KEY (recovery_of) REFERENCES executions(id);
ALTER TABLE executions ADD CONSTRAINT executions_recovery_of_unique UNIQUE (recovery_of);

CREATE INDEX executions_stale_running_idx
    ON executions (started_at, id) WHERE state='running';

-- +goose Down
DROP INDEX executions_stale_running_idx;
ALTER TABLE executions DROP CONSTRAINT executions_recovery_of_unique;
ALTER TABLE executions DROP CONSTRAINT executions_recovery_of_fk;
ALTER TABLE executions DROP COLUMN recovery_of;
