# Contributing to Price Scout

Price Scout is an infrastructure project with a browser product on top. Changes
should preserve correctness and operator trust before optimizing convenience or
throughput.

## Start here

Read these before changing a subsystem:

- [Architecture](docs/architecture.md)
- [Public API contract](contracts/openapi.yaml)
- [Untrusted-page safety decision](docs/adr/0004-untrusted-pages.md)
- [Security policy](SECURITY.md)

The quickest complete environment uses only Docker:

```bash
docker compose up --build --detach
./scripts/demo.sh wait
make demo-guide
```

Use `make help` for the full command catalog. Do not put credentials in tracked
files; `.env` is ignored.

## Repository map

| Area | Responsibility |
| --- | --- |
| `cmd/`, `internal/`, `migrations/` | Go API, scheduler, outbox, repair coordination, persistence |
| `worker/` | TypeScript Stagehand compilation, deterministic replay, validation, evidence |
| `web/` | React operator console and live SSE updates |
| `fixture/` | Deterministic two-version retailer and fault controls |
| `contracts/` | Public/internal HTTP contract |
| `deploy/` | Observability and local kind showcase |
| `docs/` | Architecture decisions, compatibility evidence, and runbooks |

## Development loops

The supported all-Docker check leaves no host `node_modules` or build output:

```bash
make test
make check
```

Focused Docker runs are available as `make test-go`, `make test-worker`,
`make test-fixture`, and `make test-web`.

Native toolchains are optional but faster while iterating:

- Go 1.25+
- Node 22.12+ with npm (not pnpm)

```bash
go test ./...

cd worker && npm ci && npm test && npm run build
cd fixture && npm ci && npm test && npm run build
cd web && npm ci && npm test && npm run build
```

Run the browser integration test only when local Chromium is available:

```bash
cd worker
RUN_BROWSER_TESTS=1 npm run test:integration
```

Deterministic CI and the fixture must never require a model or Browserbase key.
Live-site checks are manual because external pages change without repository
changes.

## Design invariants

- Postgres is authoritative; JetStream messages contain IDs, not mutable plans.
- Workers use authenticated internal HTTP and never access Postgres directly.
- Execution result submission, queue redelivery, and alerts remain idempotent.
- Scheduled checks replay a pinned plan with no model calls.
- Only one repair may be active for a monitor's failed generation.
- Repair candidates are validated before compare-and-swap activation.
- A repair observation cannot trigger a price condition; a normal check must
  reproduce it.
- Money is stored as integer minor units plus an ISO currency.
- Browser profiles and credentials are ephemeral and never retained as evidence.
- Page content is untrusted data, not instructions.

If a proposal intentionally changes one of these rules, write or update an ADR
in the same change.

## Making changes

### Go control plane

Use small handlers and keep state transitions in the store transaction that owns
them. Add an append-only Goose-compatible migration for schema changes; never
rewrite a migration that may already have run. Update `contracts/openapi.yaml`
whenever a public request or response changes.

Test transaction boundaries, duplicate submissions, redelivery, compare-and-swap
failure, and terminal states—not only the happy path. Run `go test -race ./...`
before requesting review.

### Browser worker

Keep the pinned Stagehand version exact. Use only public Stagehand APIs. Expensive
inference belongs in compile or coordinated repair; a warm check that calls a
model is a regression.

Every new action type must pass the safety gate. Never execute page-provided or
model-generated JavaScript. Add fixture coverage for selector changes,
conflicting prices, identity drift, and variant behavior before depending on a
new extraction strategy.

### Web console

The UI is an engineering console, not a source of truth. Normalize API envelopes
in the client, keep query invalidation driven by the named `update` SSE event,
and make uncertain or review-required state explicit. Preserve keyboard focus,
mobile layout, loading/empty/error states, and integer-minor-unit submission.

### Fixture and demonstrations

Faults must be explicit, deterministic, and idempotent. Add a control endpoint
rather than a timer or random mutation. Keep `/products/atlas-headphones` stable
across versions and label synthetic behavior clearly in the UI and docs.

When changing the demo, run:

```bash
make demo
```

It must prove cold compile, warm replay, redesign failure, exactly one repair,
healed replay, and a separately confirmed condition transition.

## Pull request checklist

- The change is focused and its user/operator effect is described.
- Tests fail without the change and pass with it.
- `make test` and `make check` pass.
- API/schema/config changes update their contract, example, migration, and docs.
- New failure modes have actionable logs, metrics, or a runbook.
- No credentials, cookies, browser profiles, recordings, or retailer customer
  data are included.
- Live-page claims include a date, exact conditions, and retained evidence; live
  pages are not added to CI.
- UI or demo behavior changes include a short screenshot or recording where it
  materially helps review.

Prefer a small number of coherent commits. Explain tradeoffs and known limits in
the description; do not hide a partial implementation behind aspirational docs.
