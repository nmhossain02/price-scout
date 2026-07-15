# ADR 0002: Postgres outbox with NATS JetStream delivery

Status: accepted

API mutations, scheduled executions, and their queue intent are committed in
one Postgres transaction. A relay publishes pending outbox rows to JetStream
with a stable message ID. Consumers explicitly acknowledge only after the API
accepts an idempotent result. This avoids a dual-write gap and makes worker loss
recoverable through redelivery.
