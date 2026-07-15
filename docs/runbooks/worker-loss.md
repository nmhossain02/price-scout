# Runbook: worker loss

## Signal

Executions remain `running`, a worker container or pod disappears, or the
JetStream durable consumer reports pending or redelivered messages.

The scheduler exports `scout_execution_recoveries_total{kind,outcome,prior_state}`.
An `outcome="requeued"` series means the database created a replacement;
`outcome="terminal"` means the configured recovery-attempt limit was reached.

## Automatic recovery semantics

Postgres is authoritative for a claimed execution. When an execution has been
`running` for more than `SCOUT_EXECUTION_RUNNING_STALE_AFTER` (5 minutes by
default), the scheduler performs one transaction that:

1. locks and marks the old execution `failed` with
   `failure_classification="execution_stale"`;
2. creates a new queued execution ID with `attempt + 1` and `recoveryOf` pointing
   to the old ID; and
3. inserts the replacement's JetStream message into the transactional outbox.

The new ID is a correctness boundary. On redelivery, the worker recognizes the
old terminal input and acknowledges it without repeating browser work. A result
already in flight is an idempotent no-op, so an abandoned worker cannot
overwrite the replacement. The unique `recoveryOf` constraint permits at most
one child per stale execution. Per-monitor serialization is preserved because
terminalizing the old ID and queuing its replacement happen in the same database
transaction.

Recovery stops at `SCOUT_EXECUTION_MAX_ATTEMPTS` (3 by default). A terminal
compile blocks its monitor; a terminal repair fails its repair attempt and
leaves the monitor in `needs_review`; a terminal check releases the monitor for
its next scheduled or manual check.

The same fenced lineage and attempt limit applies when a worker returns
`transient_infrastructure` or `rate_limited` for compile or repair work. The
failed attempt is retained, a new execution ID is queued transactionally, and
only the final failed attempt changes the monitor to `blocked` or finalizes the
repair as `needs_review`. These outcomes are exported as
`scout_execution_retries_total{kind,classification,outcome}`. Routine checks are
not retried immediately; their recurring schedule is the retry boundary.

Queued executions are deliberately **not** recovered by age. A long queue can
be legitimate capacity pressure, and replacing queued records would amplify an
overload. JetStream therefore retries transport and control-plane failures
without a delivery-count limit. Internally produced messages that fail the work
schema are terminally rejected and logged instead of becoming poison loops.

## Response

1. Confirm API, Postgres, and NATS readiness.
2. Inspect the execution trace and worker shutdown logs.
3. Start or scale a replacement worker. Do not manually mutate the execution;
   JetStream will redeliver unclaimed work, while the scheduler will replace a
   claimed execution after the stale threshold.
4. Inspect the execution lineage (`attempt` and `recoveryOf`) and the recovery
   counter in Grafana. Verify the replacement reaches a terminal state.
5. Verify the result endpoint accepts one result and classifies a late result
   for the old ID as an idempotent duplicate.
6. Confirm no duplicate observation or alert was created.

## Escalation

If the message does not redeliver, inspect the durable consumer's pending,
acknowledgement-pending, and redelivery counters. Transport and control-plane
failures have unlimited JetStream delivery attempts; internally produced
messages that fail the work-message schema are explicitly terminated and
logged. V1 does not provision a dead-letter stream. Preserve the execution and
NATS metadata before deciding whether to queue a fresh check.

The database does not receive the worker's 15-second JetStream heartbeats while
browser work is in progress. Set the running stale threshold above the maximum
expected job duration. The 5-minute default leaves margin above the worker's
2-minute default job budget, and configuration rejects values below 3 minutes.
A legitimately longer job can otherwise be conservatively abandoned; its late
result remains safe but the duplicated browser/model work costs resources.

`attempt` counts database recovery generations, not JetStream deliveries.
Temporary API or transport errors can redeliver the same generation many times.
Use the NATS pending/redelivery metrics alongside
`scout_execution_recoveries_total` when distinguishing worker loss from an
undersized worker pool.
