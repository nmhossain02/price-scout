#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

CLUSTER="${CLUSTER:-price-scout}"
readonly NAMESPACE="price-scout"
readonly CONTEXT="kind-$CLUSTER"
readonly CONTROL_IMAGE="price-scout-control-plane:dev"
readonly WORKER_IMAGE="price-scout-worker:dev"
readonly FIXTURE_IMAGE="price-scout-fixture:dev"
readonly WEB_IMAGE="price-scout-web:dev"

info() { printf '\033[1;36m==> %s\033[0m\n' "$*"; }
success() { printf '\033[1;32m%s\033[0m\n' "$*"; }
die() { printf '\033[1;31mError: %s\033[0m\n' "$*" >&2; exit 1; }

usage() {
  cat <<'EOF'
Usage: scripts/kind.sh <command> [argument]

  up                  Create/update cluster, load images, apply, and wait
  images              Rebuild and load the four local images
  forward             Forward console :3000 and fixture :4173 until Ctrl-C
  status              Show pods, services, PVCs, and recent events
  scale <workers>     Scale the browser worker deployment
  rollout             Gracefully roll all worker pods
  kill-worker         Delete one worker pod and watch Kubernetes replace it
  down                Delete the kind cluster

Set CLUSTER to use a different kind cluster name. Optional environment values
BROWSER_PROVIDER, MODEL_API_KEY, BROWSERBASE_API_KEY, BROWSERBASE_PROJECT_ID,
and SCOUT_FIXTURE_ORIGIN are applied when `up` runs.
EOF
}

require_tools() {
  local tool
  for tool in docker kind kubectl; do
    command -v "$tool" >/dev/null 2>&1 || die "$tool is required for the kind showcase."
  done
  docker info >/dev/null 2>&1 || die "Docker daemon is not reachable."
}

cluster_exists() {
  kind get clusters 2>/dev/null | grep -Fxq "$CLUSTER"
}

kube() {
  kubectl --context "$CONTEXT" "$@"
}

require_cluster() {
  cluster_exists || die "kind cluster '$CLUSTER' does not exist. Run 'make kind-up' first."
}

build_and_load_images() {
  require_cluster
  info "Building control-plane image"
  docker build --tag "$CONTROL_IMAGE" --file cmd/scout/Dockerfile .
  info "Building browser-worker image"
  docker build --tag "$WORKER_IMAGE" worker
  info "Building deterministic-retailer image"
  docker build --tag "$FIXTURE_IMAGE" fixture
  info "Building engineering-console image"
  docker build --tag "$WEB_IMAGE" web
  info "Loading images into kind/$CLUSTER"
  kind load docker-image --name "$CLUSTER" "$CONTROL_IMAGE" "$WORKER_IMAGE" "$FIXTURE_IMAGE" "$WEB_IMAGE"
}

apply_runtime_configuration() {
  local provider="${BROWSER_PROVIDER:-LOCAL}"
  [[ "$provider" == "LOCAL" || "$provider" == "BROWSERBASE" ]] || die "BROWSER_PROVIDER must be LOCAL or BROWSERBASE."

  # The checked-in Secret contains development-only empty values. Recreate it
  # from the operator environment without ever materializing credentials.
  kube -n "$NAMESPACE" create secret generic price-scout \
    --from-literal="WORKER_API_TOKEN=${WORKER_API_TOKEN:-kind-development-token-change-me}" \
    --from-literal="OPENAI_API_KEY=${MODEL_API_KEY:-${OPENAI_API_KEY:-}}" \
    --from-literal="BROWSERBASE_API_KEY=${BROWSERBASE_API_KEY:-}" \
    --from-literal="BROWSERBASE_PROJECT_ID=${BROWSERBASE_PROJECT_ID:-}" \
    --from-literal="ALERT_WEBHOOK_URL=${ALERT_WEBHOOK_URL:-}" \
    --from-literal="ALERT_WEBHOOK_SECRET=${ALERT_WEBHOOK_SECRET:-}" \
    --from-literal="DISCORD_WEBHOOK_URL=${DISCORD_WEBHOOK_URL:-}" \
    --dry-run=client -o yaml | kube apply -f - >/dev/null

  kube -n "$NAMESPACE" patch configmap price-scout --type merge \
    -p "{\"data\":{\"BROWSER_PROVIDER\":\"$provider\"}}" >/dev/null

  if [[ -n "${SCOUT_FIXTURE_ORIGIN:-}" ]]; then
    [[ "$SCOUT_FIXTURE_ORIGIN" == http://* || "$SCOUT_FIXTURE_ORIGIN" == https://* ]] || die "SCOUT_FIXTURE_ORIGIN must be an HTTP(S) origin."
    kube -n "$NAMESPACE" patch configmap price-scout --type merge \
      -p "{\"data\":{\"FIXTURE_ORIGIN\":\"$SCOUT_FIXTURE_ORIGIN\",\"SCOUT_FIXTURE_ORIGIN\":\"$SCOUT_FIXTURE_ORIGIN\"}}" >/dev/null
  fi

  # The standalone console image listens on 3000; preserve the named port used
  # by its Service and probe while aligning the pod with the image.
  kube -n "$NAMESPACE" patch deployment web --type=json \
    -p='[{"op":"replace","path":"/spec/template/spec/containers/0/ports/0/containerPort","value":3000}]' >/dev/null
}

wait_for_cluster() {
  info "Waiting for stateful dependencies"
  kube -n "$NAMESPACE" rollout status deployment/postgres --timeout=180s
  kube -n "$NAMESPACE" rollout status deployment/nats --timeout=180s
  kube -n "$NAMESPACE" rollout status deployment/fixture --timeout=180s
  info "Waiting for control plane and browser workers"
  kube -n "$NAMESPACE" rollout status deployment/api --timeout=240s
  kube -n "$NAMESPACE" rollout status deployment/scheduler --timeout=240s
  kube -n "$NAMESPACE" rollout status deployment/worker --timeout=360s
  kube -n "$NAMESPACE" rollout status deployment/web --timeout=180s
}

up() {
  require_tools
  if ! cluster_exists; then
    info "Creating kind cluster $CLUSTER"
    kind create cluster --name "$CLUSTER" --wait 120s
  else
    info "Using existing kind cluster $CLUSTER"
  fi
  build_and_load_images
  info "Applying deploy/kind"
  kube apply -k deploy/kind
  apply_runtime_configuration
  kube -n "$NAMESPACE" rollout restart deployment/api deployment/scheduler deployment/worker >/dev/null
  wait_for_cluster
  success "kind deployment ready. Run 'make kind-forward' and open http://127.0.0.1:3000."
}

forward() {
  require_tools
  require_cluster
  mkdir -p "$ROOT_DIR/.kind"
  info "Forwarding console http://127.0.0.1:3000 and fixture http://127.0.0.1:4173"
  info "Press Ctrl-C to stop forwarding."
  kube -n "$NAMESPACE" port-forward service/web 3000:80 >"$ROOT_DIR/.kind/web-forward.log" 2>&1 &
  local web_pid=$!
  kube -n "$NAMESPACE" port-forward service/fixture 4173:4173 >"$ROOT_DIR/.kind/fixture-forward.log" 2>&1 &
  local fixture_pid=$!
  cleanup_forward() {
    kill "$web_pid" "$fixture_pid" 2>/dev/null || true
    wait "$web_pid" "$fixture_pid" 2>/dev/null || true
  }
  trap cleanup_forward EXIT INT TERM
  sleep 2
  kill -0 "$web_pid" 2>/dev/null || { cat "$ROOT_DIR/.kind/web-forward.log" >&2; die "Console port-forward failed."; }
  kill -0 "$fixture_pid" 2>/dev/null || { cat "$ROOT_DIR/.kind/fixture-forward.log" >&2; die "Fixture port-forward failed."; }
  wait "$web_pid" "$fixture_pid"
}

status() {
  require_tools
  require_cluster
  kube -n "$NAMESPACE" get pods -o wide
  printf '\n'
  kube -n "$NAMESPACE" get services,pvc
  printf '\nRecent events:\n'
  kube -n "$NAMESPACE" get events --sort-by=.lastTimestamp | tail -20
}

scale_workers() {
  [[ "${1:-}" =~ ^[1-9][0-9]*$ ]] || die "Worker count must be a positive integer."
  (( $1 <= 100 )) || die "This local showcase caps workers at 100."
  require_tools
  require_cluster
  kube -n "$NAMESPACE" scale deployment/worker --replicas="$1"
  kube -n "$NAMESPACE" rollout status deployment/worker --timeout=360s
}

rollout_workers() {
  require_tools
  require_cluster
  info "Starting graceful worker rollout"
  kube -n "$NAMESPACE" rollout restart deployment/worker
  kube -n "$NAMESPACE" rollout status deployment/worker --timeout=360s
}

kill_worker() {
  require_tools
  require_cluster
  local pod
  pod="$(kube -n "$NAMESPACE" get pods -l app=worker -o jsonpath='{.items[0].metadata.name}')"
  [[ -n "$pod" ]] || die "No worker pod is currently available."
  info "Deleting $pod; the Deployment should replace it."
  kube -n "$NAMESPACE" delete pod "$pod" --wait=false
  kube -n "$NAMESPACE" rollout status deployment/worker --timeout=360s
  success "Worker replica count recovered. Queued work remains in JetStream."
}

down() {
  require_tools
  if cluster_exists; then
    kind delete cluster --name "$CLUSTER"
    rm -rf "$ROOT_DIR/.kind"
  else
    info "kind cluster $CLUSTER does not exist."
  fi
}

main() {
  local command="${1:-help}"
  shift || true
  case "$command" in
    up) up ;;
    images) require_tools; build_and_load_images ;;
    forward) forward ;;
    status) status ;;
    scale) scale_workers "$@" ;;
    rollout) rollout_workers ;;
    kill-worker) kill_worker ;;
    down) down ;;
    help|-h|--help) usage ;;
    *) usage >&2; die "Unknown command '$command'." ;;
  esac
}

main "$@"
