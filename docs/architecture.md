# Price Scout architecture

Price Scout compiles an agent-discovered product workflow into a versioned,
deterministic monitor. Expensive model inference is reserved for initial
compilation and coordinated repair; scheduled checks replay stored actions and
selectors without model calls.

```text
React engineering console
           |
           v
Go API ----+---- Postgres (plans, executions, outbox, evidence metadata)
           |         |
           |         v
           +---- NATS JetStream ---- TypeScript Stagehand workers
                                      |                 |
                                 local Chromium    Browserbase
```

## Runtime invariants

- Postgres is authoritative. NATS messages carry identifiers, not mutable plan
  state.
- Workers never connect directly to Postgres; they fetch an immutable execution
  input and submit an idempotent result through the internal API.
- Routine checks disable Stagehand self-healing. Scheduler and API rules
  serialize normal executions for each monitor. A unique repair record for one
  monitor and failed generation also prevents duplicate or concurrent failure
  delivery from creating multiple repair attempts. It does not coordinate
  repairs across monitors or sites; shared-plan repair is future work.
- A candidate repair revision is promoted only after a separate browser session
  replays it with self-healing and model calls disabled. Repair observations
  never alert directly. Initial compile candidates remain human-confirmed.
- Only verified observations can update condition state. Alerts are emitted on
  false-to-true transitions and use an idempotency key.
- Browser profiles are ephemeral and never persisted into the repository.
- Each worker process pulls one JetStream delivery only when ready to start it;
  replicas therefore share work without an un-heartbeated client-side backlog.
- Claimed executions that outlive the configured job budget are terminalized
  and replaced transactionally with a new execution ID. Late results for the
  abandoned ID are idempotent no-ops. Queued work is never expired by age,
  because queue delay may represent legitimate capacity pressure.
- Engineering-console SSE events use an in-process broker. The supported Kind
  deployment therefore runs one API replica; distributed scale is demonstrated
  by the three-worker pool until the event bus is externalized.

## Supported boundary

The first release reads public single-product pages and may select explicitly
requested product variants (Stagehand may scroll internally to locate them). It does not log
in, bypass challenges, add to cart, purchase, upload, or execute model-generated
code. Before navigation, both the API and worker resolve targets and reject
private or special-use addresses unless the explicitly configured fixture
exception applies. Public hosts are constrained by Stagehand's domain policy,
and the worker rejects a final page URL that leaves the original origin. V1 does
not independently resolve and inspect every intermediate redirect hop, so a
production installation should also enforce outbound-network policy.

For cached actions whose selectors still resolve, the worker inspects the
located element's text/HTML before interaction and checks same-origin afterward.
Stagehand's direct-action API returns a self-healed replacement only after it has
executed, so stale-selector replacements can only be inspected immediately
afterward; unsafe replacements are rejected and never persisted. Browser
isolation and outbound-network policy remain required defense in depth.
