#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

readonly NODE_IMAGE="node:22-bookworm-slim"
readonly GO_IMAGE="golang:1.25-bookworm"

info() { printf '\033[1;36m==> %s\033[0m\n' "$*"; }
die() { printf '\033[1;31mError: %s\033[0m\n' "$*" >&2; exit 1; }

require_docker() {
  command -v docker >/dev/null 2>&1 || die "Docker is required for repository-isolated tests."
  docker info >/dev/null 2>&1 || die "Docker daemon is not reachable."
}

test_go() {
  info "Go control plane"
  docker run --rm \
    --volume "$ROOT_DIR:/src:ro" \
    --workdir /src \
    --env GOCACHE=/tmp/go-cache \
    --env GOMODCACHE=/tmp/go-mod-cache \
    "$GO_IMAGE" \
    go test ./...
}

test_node() {
  local workspace="$1" label="$2"
  local -a extra_mounts=()
  if [[ "$workspace" == "worker" ]]; then
    # The opt-in browser integration suite imports the shared fixture at module
    # load time even when RUN_BROWSER_TESTS is unset.
    extra_mounts+=(--volume "$ROOT_DIR/fixture:/fixture:ro")
  fi
  info "$label"
  docker run --rm \
    --volume "$ROOT_DIR/$workspace:/src:ro" \
    --volume /src/node_modules \
    --volume /src/dist \
    "${extra_mounts[@]}" \
    --workdir /src \
    "$NODE_IMAGE" \
    sh -ceu 'npm ci --no-audit --no-fund; npm test; npm run build'
}

test_shell() {
  info "Shell syntax"
  local file
  while IFS= read -r file; do
    bash -n "$file"
  done < <(find scripts -type f -name '*.sh' -print | sort)
}

test_compose() {
  info "Docker Compose model"
  docker compose config --quiet
}

usage() {
  cat <<'EOF'
Usage: scripts/test.sh [all|go|worker|fixture|web|shell|compose]

Tests use disposable Docker containers and anonymous tmpfs mounts. They do not
create host node_modules/dist directories or require host language toolchains.
EOF
}

main() {
  local suite="${1:-all}"
  case "$suite" in
    all)
      require_docker
      test_shell
      test_compose
      test_go
      test_node worker "TypeScript browser worker"
      test_node fixture "Synthetic retailer fixture"
      test_node web "React engineering console"
      ;;
    go) require_docker; test_go ;;
    worker) require_docker; test_node worker "TypeScript browser worker" ;;
    fixture) require_docker; test_node fixture "Synthetic retailer fixture" ;;
    web) require_docker; test_node web "React engineering console" ;;
    shell) test_shell ;;
    compose) require_docker; test_compose ;;
    help|-h|--help) usage ;;
    *) usage >&2; die "Unknown suite '$suite'." ;;
  esac
}

main "$@"
