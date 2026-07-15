# Price Scout

Price Scout is a self-hosted system that turns a public product page and a
plain-language condition into a versioned, repeatable browser monitor.

An agentic browser discovers the product, variant controls, current price, and
availability once. After confirmation, scheduled checks replay the compiled
plan without model calls. If a redesign breaks that plan, one repair is
coordinated for the failed generation instead of letting every worker infer its
own replacement.

The repository is both a useful personal price monitor and a distributed-browser
engineering demonstration: durable work, idempotent results, browser evidence,
worker recovery, versioned compiled plans, duplicate repair suppression, and an
observable control plane.

The checked-in Compose and Kind deployments are single-operator, local portfolio
environments—not production or multi-tenant security boundaries. Local Chromium
runs without its process sandbox inside a least-privilege worker container, and
hostname allowlisting does not prevent DNS rebinding by itself. Before monitoring
untrusted live targets in a real deployment, isolate browser workers from control
plane secrets and enforce egress that resolves and pins public destination IPs
while denying private, special-use, and metadata networks.

## Run it locally

Docker with the Compose v2 plugin is the only requirement. You do **not** need
Node, pnpm, Go, Postgres, NATS, or Chrome installed on the host.

From the project directory:

```bash
docker compose up --build --detach
```

Wait for the API to report healthy, then open:

- Price Scout: [http://127.0.0.1:3000](http://127.0.0.1:3000)
- Controlled retailer: [http://127.0.0.1:4173/products/atlas-headphones](http://127.0.0.1:4173/products/atlas-headphones)

```bash
docker compose ps
```

The bundled retailer and its scripted compiler need no provider credentials.
Data, queue state, and browser evidence survive restarts in Docker volumes.

If `make` is available, `make up`, `make logs`, `make down`, and `make help`
provide shorter equivalents. `make clean` is intentionally destructive: it
also removes the database, JetStream, evidence, and observability volumes.

## Watch coordinated repair happen

The demo models a real failure: a frontend team deploys a redesign while a
price monitor is active. The product and URL remain the same, but stable-looking
DOM selectors change from the legacy UI to a design-system component.

The credential-free fixture deliberately uses a **scripted deterministic
recompile** inside the one permitted repair job. It proves failure detection,
duplicate repair suppression for one monitor generation, generation replacement,
validation, and healed replay; it does not pretend that a model was called. For
live pages configured with a model, the same repair lease invokes Stagehand's
agentic discovery/self-heal path.

### Browser-led walkthrough

1. Reset the retailer to v1:

   ```bash
   make demo-reset
   # Without make: ./scripts/demo.sh reset
   ```

2. Open Price Scout, select **New monitor**, and enter:

   ```text
   URL
   http://fixture:4173/products/atlas-headphones

   Instruction
   Alert me when the black 2 TB version is in stock and the total price is below 1000 USD
   ```

   `fixture` is the retailer's name inside the Docker network. Use the localhost
   link above only when following the storefront in your own browser.

3. Watch compilation finish. Inspect its captured evidence, set the threshold
   to **1000 USD**, leave **Require in-stock status** selected, and confirm the
   candidate plan.

4. Select **Check now**. This is a warm deterministic replay with no model call.

5. Deliberately ship the new storefront:

   ```bash
   make demo-deploy
   ```

   Refresh the retailer tab to see v2, then select **Check now** again. The old
   generation fails, a single scripted repair is queued, and the validated v2 plan is
   promoted. The execution and revision views preserve the failure and evidence.

6. Select **Check now** once more. The repaired generation now replays normally.

7. Cross the target price:

   ```bash
   make demo-price PRICE=849.00
   ```

   The selected 2 TB option adds $150, so the observed total is $999. Run a final
   check. Price Scout schedules a separate confirmation check before changing
   the condition from false to true.

The control surface is deterministic and explicit—there are no timers or random
DOM changes:

```bash
make demo-state                    # current version, base price, and stock
make demo-reset                    # v1, $1,099 base, in stock
make demo-deploy                   # idempotently deploy v2
make demo-price PRICE=799.95       # dollars; converted to integer minor units
make demo-stock STOCK=out          # use in or out
```

To run the same sequence unattended:

```bash
make demo
```

That command proves cold compilation → warm replay → stale generation → one
deterministic recompile repair → healed replay → confirmed price condition, then
prints the monitor URL for inspection. It still uses the real API, Postgres
outbox, JetStream, browser worker, revision promotion, screenshots, and
condition state machine.

## System design

```text
Browser engineering console
          │ HTTP + SSE
          ▼
Go API ─────────── Postgres
  │                  │ monitors, revisions, executions,
  │ transactional    │ observations, evidence metadata,
  │ outbox            │ repair leases, alert transitions
  ▼                  │
NATS JetStream ◀─────┘
  │ durable IDs
  ▼
TypeScript Stagehand workers ── local Chromium or Browserbase
  │
  └── screenshots + page snapshots on a persistent artifact volume
```

Postgres is authoritative; queue messages carry execution IDs rather than
mutable plans. Workers never connect to the database. They claim immutable input
through an authenticated internal API and submit idempotent results through the
same boundary.

Routine checks explicitly disable self-healing. A stale deterministic execution
creates a unique repair attempt for `(monitor, failed generation)`. Only that
repair may use inference; successful candidates are validated before an atomic
generation swap. Repair validation uses a separate browser session with
self-healing and model calls disabled, so the candidate must replay
deterministically. A repair observation can never fire an alert directly—the next
normal browser check must reproduce it. Scheduler and API rules serialize normal
executions for each monitor; the unique repair key additionally protects against
duplicate or concurrent delivery of the same failure. It does not deduplicate
repairs across monitors or sites. Sharing repaired plans across compatible
monitors is future work.

More detail is available in [the architecture guide](docs/architecture.md), the
[OpenAPI contract](contracts/openapi.yaml), and [architecture decisions](docs/adr/).

## Browser execution modes

### Local Chromium

Compose defaults to `BROWSER_PROVIDER=LOCAL`. Chromium is contained in the
worker image. This is free, offline-friendly for the fixture, and best for local
development.

### Browserbase

Browserbase supplies the remote browser and session replay; inference remains
controlled by your self-hosted worker. Put credentials in `.env` (never commit
it):

```dotenv
BROWSER_PROVIDER=BROWSERBASE
BROWSERBASE_API_KEY=bb_live_...
BROWSERBASE_PROJECT_ID=...
```

For an arbitrary public page, also configure the model used during compile or
repair:

```dotenv
STAGEHAND_MODEL=openai/gpt-4.1-mini
MODEL_API_KEY=...
```

Warm checks do not use that model. Browserbase session links appear on completed
execution pages.

## Notifications

Configure either or both installation-wide channels in `.env` before starting
the API:

```dotenv
# Generic JSON webhook; the secret is required when this URL is set.
ALERT_WEBHOOK_URL=https://hooks.example.com/price-scout
ALERT_WEBHOOK_SECRET=replace-with-a-long-random-secret

# Or a Discord webhook URL.
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/...
```

Generic webhooks include an idempotency key plus
`X-Price-Scout-Timestamp` and an HMAC-SHA256 `X-Price-Scout-Signature` over
`<timestamp>.<exact body>`. Discord messages disable mentions and use the
delivery ID as a nonce. Both channels use leased delivery work, bounded retries,
and `Retry-After` handling. A price transition is delivered only after the
separate confirmation browser check succeeds.

The Compose fixture is private by design, so a Browserbase cloud browser cannot
resolve `http://fixture:4173`. Before opening a tunnel, set a unique fixture
control token in the ignored `.env` file; the bundled demo commands read the
same value from the running fixture container:

```dotenv
FIXTURE_CONTROL_TOKEN=replace-with-a-long-random-value
```

Then expose only the fixture through a temporary tunnel:

```bash
# Terminal 1: start Price Scout first
docker compose up --build --detach

# Terminal 2: this joins the Compose network and prints an ephemeral HTTPS URL
docker run --rm --network price-scout_default \
  cloudflare/cloudflared:latest tunnel --no-autoupdate \
  --url http://fixture:4173
```

Add the printed origin to `.env` along with the Browserbase credentials:

```dotenv
SCOUT_FIXTURE_ORIGIN=https://example-random-name.trycloudflare.com
```

Recreate the two consumers of that setting:

```bash
docker compose up --detach --force-recreate api worker
```

Create the demo monitor with the tunneled URL plus
`/products/atlas-headphones`. Keep the tunnel process running for the session.
Do not expose the API, database, NATS, or artifact volume through the tunnel.

## Supported product boundary

Price Scout v1 supports unauthenticated, public, single-product pages. It may
select explicitly requested product variants; Stagehand may scroll internally
while locating those controls. It rejects private/reserved targets, credentials
in URLs, unsafe ports, cross-origin navigation, model-generated scripts, and
purchase actions.
The v1 money model accepts two-decimal USD, CAD, EUR, GBP, and AUD prices; other
currencies fail closed instead of being converted or guessed.

Cached targets that still resolve are inspected before interaction. When a
selector is stale, Stagehand's direct-action API exposes its healed replacement
only after executing it; the worker immediately checks the replacement and
refuses to persist an unsafe action, but cannot pre-authorize that replacement.
Run browsers in an isolated network/container boundary for live targets.
The initial DNS checks and Stagehand hostname policy do not pin the IP used by
later browser requests; production egress controls must close that DNS-rebinding
gap rather than relying on application validation alone.

It does not promise CAPTCHA bypass, authenticated/member pricing, cart totals,
tax or shipping calculation, automatic purchasing, flights, tickets, or every
retailer. Live-site compatibility is manually qualified and never gates CI;
see the [compatibility report](docs/compatibility-report.md).

A failed extraction is safer than a confident wrong price. Currency conflicts,
identity drift, missing selected variants, and ambiguous or installment prices
are sent for review instead of silently alerting. V1 persists deduplicated
condition transitions and delivers them through configured webhook or Discord
channels.

The console is unauthenticated and binds to `127.0.0.1` by default. Put an
authenticated TLS reverse proxy in front of it before any network exposure.
Read [SECURITY.md](SECURITY.md) before using real targets.

## Operations and development

```bash
make help               # complete command catalog
make logs               # API, scheduler, worker
make ops-up             # Prometheus :9090 and Grafana :3001
make test               # all suites in disposable Docker containers
make check              # shell syntax and rendered Compose validation
```

The API-local Prometheus metrics are available at
[http://127.0.0.1:3000/metrics](http://127.0.0.1:3000/metrics). `make ops-up`
starts Prometheus, which also scrapes the scheduler and NATS exporter, plus a
Grafana dashboard at [http://127.0.0.1:3001](http://127.0.0.1:3001). The
dashboard includes `scout_execution_recoveries_total`, showing requeued versus
terminal stale-work outcomes by execution kind, while
`scout_execution_retries_total` shows bounded transient compile/repair retries.
See the
[worker-loss runbook](docs/runbooks/worker-loss.md) for the bounded recovery
semantics and operational tradeoffs.

### Kubernetes showcase

The kind deployment demonstrates three browser workers, worker replacement,
scaling, and graceful rolling restarts. It is a local portfolio environment,
not a production high-availability distribution.

Install Docker, `kind`, and `kubectl`, then run:

```bash
make kind-up
make kind-forward       # keep this terminal open
# open http://127.0.0.1:3000
```

In another terminal:

```bash
make kind-status
make kind-scale WORKERS=5
make kind-kill-worker
make kind-rollout
make kind-down
```

`make kind-images` rebuilds and reloads local images without replacing the
cluster. The kind environment uses single-node Postgres/NATS and local PVCs; it
does not claim multi-region operation, database HA, or zero-downtime migrations.

## License

[MIT](LICENSE)
