# ADR 0003: Coordinate one repair per monitor generation

Status: accepted

Scheduler and API rules serialize normal executions for an individual monitor,
so v1 does not accumulate many concurrent checks for that monitor. A unique
constraint on `(monitor_id, failed_generation)` is an additional idempotency
guard: duplicate or concurrent delivery of the same failure can create only one
repair attempt. Routine workers do not self-heal independently. The repair
worker may use Stagehand inference, validates a new revision, and activates it
with compare-and-swap. Subsequent checks for that monitor use the current
revision.

This coordination is scoped to one monitor and failed generation. It does not
deduplicate repairs across monitors that happen to target the same site or share
a compatible plan. Cross-monitor shared-plan repair is future work.
