#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

readonly API_URL="http://api:8080"
readonly FIXTURE_URL="http://127.0.0.1:4173"
readonly PRODUCT_URL="http://fixture:4173/products/atlas-headphones"
readonly STATE_DIR="$ROOT_DIR/tmp/demo"
readonly MONITOR_FILE="$STATE_DIR/monitor-id"
readonly DEFAULT_INTENT="Alert me when the black 2 TB version is in stock and the total price is below 1000 USD"
readonly DEFAULT_THRESHOLD_MINOR=100000

COMPOSE=(docker compose)

info() { printf '\033[1;36m%s\033[0m\n' "$*"; }
success() { printf '\033[1;32m%s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m%s\033[0m\n' "$*" >&2; }
die() { printf '\033[1;31mError: %s\033[0m\n' "$*" >&2; exit 1; }

usage() {
  cat <<'EOF'
Price Scout deterministic demo

Usage: scripts/demo.sh <command> [value]

Lifecycle:
  up                 Build and start the Docker Compose stack
  wait               Wait for the API, queue, and fixture to be ready
  down               Stop the stack without deleting persisted data
  clean              Stop the stack and delete its volumes
  logs               Follow API, scheduler, and worker logs

Fixture controls:
  reset              Restore storefront v1, $1,099 base price, and in-stock state
  deploy             Deliberately deploy storefront v2
  price <dollars>    Set base price, for example: price 849.00
  stock <in|out>     Set product availability
  state              Print current fixture state

Monitor demo:
  create             Queue a fixture monitor compilation
  confirm            Activate the compiled plan with a $1,000 threshold
  check              Queue a check and wait for its result
  status             Print saved monitor detail
  guide              Print the browser-led walkthrough
  run                Run the full cold/warm/redesign/repair/price-drop sequence

Only Docker with Compose is required. Node, Go, pnpm, jq, and a local browser
automation installation are not used by this script.
EOF
}

require_docker() {
  command -v docker >/dev/null 2>&1 || die "Docker is required. Install Docker Desktop or Docker Engine first."
  docker compose version >/dev/null 2>&1 || die "The Docker Compose v2 plugin is required (docker compose)."
  docker info >/dev/null 2>&1 || die "Docker is installed but its daemon is not reachable."
}

# Run fetch and JSON parsing inside the already-running fixture container. This
# keeps the operator path Docker-only and avoids host curl/jq/Node dependencies.
request() {
  local method="$1" url="$2" body="${3:-}" key="${4:-}"
  "${COMPOSE[@]}" exec -T fixture node -e '
    const [url, method, body, key] = process.argv.slice(1);
    const headers = {};
    if (body) headers["Content-Type"] = "application/json";
    if (key) headers["Idempotency-Key"] = key;
    if (url.includes("127.0.0.1:4173") && method !== "GET") {
      headers["X-Fixture-Token"] = process.env.FIXTURE_CONTROL_TOKEN || "development-fixture-token";
    }
    fetch(url, { method, headers, ...(body ? { body } : {}) })
      .then(async response => {
        const text = await response.text();
        if (!response.ok) {
          console.error(`${method} ${url} failed (${response.status}): ${text}`);
          process.exit(22);
        }
        process.stdout.write(text);
      })
      .catch(error => { console.error(error.message); process.exit(23); });
  ' "$url" "$method" "$body" "$key"
}

json_get() {
  local path="$1"
  "${COMPOSE[@]}" exec -T fixture node -e '
    const path = process.argv[1].split(".").filter(Boolean);
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", chunk => { input += chunk; });
    process.stdin.on("end", () => {
      try {
        let value = JSON.parse(input);
        for (const segment of path) value = value?.[segment.match(/^\d+$/) ? Number(segment) : segment];
        if (value === undefined || value === null) process.exit(3);
        process.stdout.write(typeof value === "object" ? JSON.stringify(value) : String(value));
      } catch (error) {
        console.error(error.message);
        process.exit(4);
      }
    });
  ' "$path"
}

service_request() {
  request GET "$1" 2>/dev/null
}

wait_for_services() {
  local deadline=$((SECONDS + 180))
  info "Waiting for the fixture and control plane..."
  until "${COMPOSE[@]}" exec -T fixture node -e '
    Promise.all([
      fetch("http://127.0.0.1:4173/healthz").then(r => { if (!r.ok) throw new Error(); }),
      fetch("http://api:8080/readyz").then(r => { if (!r.ok) throw new Error(); }),
    ]).then(() => process.exit(0)).catch(() => process.exit(1));
  ' >/dev/null 2>&1; do
    (( SECONDS < deadline )) || {
      "${COMPOSE[@]}" ps >&2 || true
      "${COMPOSE[@]}" logs --tail=80 api worker fixture >&2 || true
      die "Services did not become ready within 180 seconds."
    }
    sleep 2
  done
  success "Ready: console http://127.0.0.1:3000 · fixture http://127.0.0.1:4173/products/atlas-headphones"
}

wait_for_value() {
  local url="$1" path="$2" expected="$3" timeout="${4:-120}"
  local deadline=$((SECONDS + timeout)) response value=""
  while (( SECONDS < deadline )); do
    if response="$(service_request "$url")" && value="$(printf '%s' "$response" | json_get "$path" 2>/dev/null)"; then
      if [[ "$value" == "$expected" ]]; then
        printf '%s' "$response"
        return 0
      fi
    fi
    sleep 1
  done
  die "Timed out waiting for $path=$expected at $url (last value: ${value:-unavailable})."
}

wait_for_change() {
  local url="$1" path="$2" previous="$3" timeout="${4:-180}"
  local deadline=$((SECONDS + timeout)) response value=""
  while (( SECONDS < deadline )); do
    if response="$(service_request "$url")" && value="$(printf '%s' "$response" | json_get "$path" 2>/dev/null)"; then
      if [[ -n "$value" && "$value" != "$previous" ]]; then
        printf '%s' "$response"
        return 0
      fi
    fi
    sleep 1
  done
  die "Timed out waiting for $path to change from $previous (last value: ${value:-unavailable})."
}

assert_next_run_leaves_manual_window() {
  local detail="$1" context="$2"
  printf '%s' "$detail" | "${COMPOSE[@]}" exec -T fixture node -e '
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", chunk => { input += chunk; });
    process.stdin.on("end", () => {
      const detail = JSON.parse(input);
      const next = Date.parse(detail.monitor?.nextRunAt);
      if (!Number.isFinite(next) || next <= Date.now() + 5 * 60_000) {
        console.error(`nextRunAt ${detail.monitor?.nextRunAt ?? "missing"} does not leave a deterministic manual-check window`);
        process.exit(1);
      }
    });
  ' || die "$context scheduled an immediate automatic check; the browser-led Check now step would race the scheduler."
}

wait_for_execution() {
  local execution_id="$1" timeout="${2:-150}"
  local deadline=$((SECONDS + timeout)) response state=""
  while (( SECONDS < deadline )); do
    if response="$(service_request "$API_URL/api/v1/executions/$execution_id")" && state="$(printf '%s' "$response" | json_get state 2>/dev/null)"; then
      case "$state" in
        succeeded|failed|blocked|needs_review)
          printf '%s' "$response"
          return 0
          ;;
      esac
    fi
    sleep 1
  done
  die "Execution $execution_id did not finish within ${timeout}s (last state: ${state:-unavailable})."
}

saved_monitor_id() {
  [[ -s "$MONITOR_FILE" ]] || die "No saved demo monitor. Run 'scripts/demo.sh create' first."
  tr -d '[:space:]' < "$MONITOR_FILE"
}

fixture_control() {
  local endpoint="$1" body="${2-}"
  [[ -n "$body" ]] || body='{}'
  request POST "$FIXTURE_URL/__control/$endpoint" "$body"
  printf '\n'
}

dollars_to_minor() {
  local value="${1#\$}"
  [[ "$value" =~ ^[0-9]+([.][0-9]{1,2})?$ ]] || die "Price must be positive dollars, such as 849 or 849.00."
  local whole="${value%%.*}" fraction="00"
  if [[ "$value" == *.* ]]; then
    fraction="${value#*.}0"
    fraction="${fraction:0:2}"
  fi
  local minor=$((10#$whole * 100 + 10#$fraction))
  (( minor > 0 )) || die "Price must be greater than zero."
  printf '%s' "$minor"
}

up() {
  require_docker
  info "Building and starting Price Scout..."
  "${COMPOSE[@]}" up --build --detach
  wait_for_services
}

reset_fixture() {
  info "Resetting the synthetic retailer to storefront v1..."
  fixture_control reset '{}'
}

deploy_fixture() {
  info "Deploying storefront v2 (same product, redesigned DOM)..."
  fixture_control deploy '{}'
}

set_price() {
  [[ $# -eq 1 ]] || die "Usage: scripts/demo.sh price <dollars>"
  local minor
  minor="$(dollars_to_minor "$1")"
  info "Setting fixture base price to \$$1 (${minor} minor units)..."
  fixture_control price "{\"priceMinor\":$minor}"
}

set_stock() {
  [[ $# -eq 1 ]] || die "Usage: scripts/demo.sh stock <in|out>"
  local value
  case "${1,,}" in
    in|true|available) value=true ;;
    out|false|unavailable) value=false ;;
    *) die "Stock must be 'in' or 'out'." ;;
  esac
  info "Setting fixture stock to ${1,,}..."
  fixture_control stock "{\"inStock\":$value}"
}

create_monitor() {
  mkdir -p "$STATE_DIR"
  info "Queuing cold compilation against storefront v1..."
  local body response monitor_id execution_id detail
  body="{\"url\":\"$PRODUCT_URL\",\"intent\":\"$DEFAULT_INTENT\",\"intervalMinutes\":360}"
  response="$(request POST "$API_URL/api/v1/monitors" "$body")"
  monitor_id="$(printf '%s' "$response" | json_get monitor.id)"
  execution_id="$(printf '%s' "$response" | json_get execution.id)"
  printf '%s\n' "$monitor_id" > "$MONITOR_FILE"
  info "Monitor $monitor_id · compile execution $execution_id"
  detail="$(wait_for_value "$API_URL/api/v1/monitors/$monitor_id" monitor.status awaiting_confirmation 180)"
  success "Cold compile complete. Candidate generation $(printf '%s' "$detail" | json_get revisions.0.generation) awaits confirmation."
  printf '%s\n' "$detail"
}

confirm_monitor() {
  local monitor_id detail revision_id body
  monitor_id="$(saved_monitor_id)"
  detail="$(request GET "$API_URL/api/v1/monitors/$monitor_id")"
  revision_id="$(printf '%s' "$detail" | json_get revisions.0.id)"
  body="{\"revisionId\":\"$revision_id\",\"condition\":{\"priceBelowMinor\":$DEFAULT_THRESHOLD_MINOR,\"currency\":\"USD\",\"requireInStock\":true,\"requestedVariant\":{\"color\":\"black\",\"capacity\":\"2tb\"}}}"
  info "Confirming generation 1 with a \$1,000 in-stock threshold..."
  request POST "$API_URL/api/v1/monitors/$monitor_id/confirm" "$body"
  printf '\n'
  success "Monitor active."
}

queue_check() {
  local monitor_id key response execution_id result state
  monitor_id="$(saved_monitor_id)"
  key="demo-$(date +%s)-$RANDOM"
  response="$(request POST "$API_URL/api/v1/monitors/$monitor_id/checks" '' "$key")"
  execution_id="$(printf '%s' "$response" | json_get execution.id)"
  info "Queued check $execution_id"
  result="$(wait_for_execution "$execution_id")"
  state="$(printf '%s' "$result" | json_get state)"
  if [[ "$state" == "succeeded" ]]; then
    local price
    price="$(printf '%s' "$result" | json_get observation.priceMinor 2>/dev/null || true)"
    success "Check succeeded${price:+ · observed $price minor units}."
  else
    warn "Check finished as $state. This is expected immediately after the deliberate redesign."
  fi
  printf '%s\n' "$result"
}

show_status() {
  local monitor_id
  monitor_id="$(saved_monitor_id)"
  request GET "$API_URL/api/v1/monitors/$monitor_id"
  printf '\n'
}

guide() {
  cat <<'EOF'

Browser-led walkthrough
========================

1. Start the stack:
     make up

2. Open both pages:
     Console: http://127.0.0.1:3000
     Store:   http://127.0.0.1:4173/products/atlas-headphones

3. Reset the controlled retailer:
     make demo-reset

4. In the console choose “New monitor” and enter:
     URL: http://fixture:4173/products/atlas-headphones
     Instruction: Alert me when the black 2 TB version is in stock and the
                  total price is below 1000 USD

5. Wait for compilation, inspect the screenshot evidence, enter 1000 USD as
   the threshold, keep “Require in-stock status” selected, and confirm.

6. Click “Check now”. This is a warm deterministic replay: no model call.

7. In a terminal deliberately ship the redesign:
     make demo-deploy
   Refresh the Store tab to see v2. Then click “Check now” in Price Scout.
   The old action fails, one repair is coordinated, and generation 2 becomes
   active. The product identity and URL never changed.

8. Run another “Check now”. The healed generation replays successfully.

9. Cross the target threshold and check once more:
     make demo-price PRICE=849.00
   The selected 2 TB option adds $150, producing a $999 observed total. Price
   Scout runs a separate confirmation check before marking the condition met.

The fixture is deliberately controlled fault injection. It makes the browser
failure deterministic while the scheduler, queue, workers, evidence, repair
lease, revisions, and alert transition are the real system.
EOF
}

run_demo() {
  up
  reset_fixture >/dev/null
  create_monitor >/dev/null
  confirm_monitor >/dev/null

  local monitor_id activation_detail before_revision after_detail after_revision
  monitor_id="$(saved_monitor_id)"
  activation_detail="$(request GET "$API_URL/api/v1/monitors/$monitor_id")"
  assert_next_run_leaves_manual_window "$activation_detail" "Initial confirmation"

  info "Step 1/4: warm replay on storefront v1"
  queue_check >/dev/null

  before_revision="$(request GET "$API_URL/api/v1/monitors/$monitor_id" | json_get monitor.currentRevisionId)"

  info "Step 2/4: ship v2 and exercise coordinated repair"
  deploy_fixture >/dev/null
  queue_check >/dev/null
  # Do not poll status here: an auto-promoted repair can move through `active`
  # while the old revision is still visible. The generation pointer is the
  # compare-and-swap outcome we actually need to prove.
  after_detail="$(wait_for_change "$API_URL/api/v1/monitors/$monitor_id" monitor.currentRevisionId "$before_revision" 180)"
  after_revision="$(printf '%s' "$after_detail" | json_get monitor.currentRevisionId)"
  [[ "$after_revision" != "$before_revision" ]] || die "Repair did not publish a new revision."
  assert_next_run_leaves_manual_window "$after_detail" "Repair promotion"
  success "The single scripted repair published a new active generation."

  info "Step 3/4: replay the healed generation"
  queue_check >/dev/null

  info "Step 4/4: move the selected configuration below its target"
  set_price 849.00 >/dev/null
  queue_check >/dev/null
  wait_for_value "$API_URL/api/v1/monitors/$monitor_id" monitor.conditionMatched true 180 >/dev/null

  success "Demo complete: cold compile → plan replay → redesign → one scripted repair → healed replay → confirmed price condition."
  printf '\nOpen http://127.0.0.1:3000/monitors/%s to inspect revisions, executions, and evidence.\n' "$monitor_id"
}

main() {
  local command="${1:-help}"
  shift || true
  case "$command" in
    help|-h|--help) usage ;;
    up) up ;;
    wait) require_docker; wait_for_services ;;
    down) require_docker; "${COMPOSE[@]}" --profile ops down ;;
    clean) require_docker; warn "Deleting Price Scout database, queue, evidence, and observability volumes."; "${COMPOSE[@]}" --profile ops down --volumes --remove-orphans; rm -rf "$STATE_DIR" ;;
    logs) require_docker; "${COMPOSE[@]}" logs --follow --tail=200 api scheduler worker ;;
    reset) require_docker; reset_fixture ;;
    deploy) require_docker; deploy_fixture ;;
    price) require_docker; set_price "$@" ;;
    stock) require_docker; set_stock "$@" ;;
    state) require_docker; request GET "$FIXTURE_URL/__control/state"; printf '\n' ;;
    create) require_docker; create_monitor ;;
    confirm) require_docker; confirm_monitor ;;
    check) require_docker; queue_check ;;
    status) require_docker; show_status ;;
    guide) guide ;;
    run) run_demo ;;
    *) usage >&2; die "Unknown command '$command'." ;;
  esac
}

main "$@"
