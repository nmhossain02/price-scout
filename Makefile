SHELL := /usr/bin/env bash
.DEFAULT_GOAL := help

PRICE ?= 849.00
STOCK ?= in
WORKERS ?= 3
CLUSTER ?= price-scout

.PHONY: help up down clean status logs ops-up ops-down demo demo-guide demo-reset demo-deploy demo-price demo-stock demo-state demo-create demo-confirm demo-check test test-go test-worker test-fixture test-web check kind-up kind-down kind-images kind-forward kind-status kind-scale kind-rollout kind-kill-worker

help: ## Show available operator and development commands
	@awk 'BEGIN {FS = ":.*## "; printf "Price Scout commands\n\n"} /^[a-zA-Z0-9_-]+:.*## / {printf "  \033[36m%-20s\033[0m %s\n", $$1, $$2}' $(MAKEFILE_LIST)

up: ## Build and start the self-hosted stack, then wait for readiness
	@./scripts/demo.sh up

down: ## Stop services while preserving database, queue, and evidence volumes
	@./scripts/demo.sh down

clean: ## Stop services and delete all local Price Scout volumes
	@./scripts/demo.sh clean

status: ## Show Compose service and health state
	@docker compose ps

logs: ## Follow control-plane and browser-worker logs
	@./scripts/demo.sh logs

ops-up: ## Start the optional Prometheus and Grafana profile
	@docker compose --profile ops up --detach prometheus grafana
	@printf 'Prometheus: http://127.0.0.1:9090\nGrafana:    http://127.0.0.1:3001\n'

ops-down: ## Stop the optional observability services
	@docker compose --profile ops stop prometheus grafana nats-exporter

demo: ## Run the complete deterministic coordinated-repair demonstration
	@./scripts/demo.sh run

demo-guide: ## Print the browser-led demonstration walkthrough
	@./scripts/demo.sh guide

demo-reset: ## Restore synthetic retailer v1 and its initial state
	@./scripts/demo.sh reset

demo-deploy: ## Deliberately deploy the synthetic retailer v2 redesign
	@./scripts/demo.sh deploy

demo-price: ## Set fixture base price (usage: make demo-price PRICE=849.00)
	@./scripts/demo.sh price "$(PRICE)"

demo-stock: ## Set fixture availability (usage: make demo-stock STOCK=out)
	@./scripts/demo.sh stock "$(STOCK)"

demo-state: ## Print the current controlled-retailer state
	@./scripts/demo.sh state

demo-create: ## Queue a fixture monitor and save its ID locally
	@./scripts/demo.sh create

demo-confirm: ## Confirm the saved fixture monitor with the demo rule
	@./scripts/demo.sh confirm

demo-check: ## Check the saved fixture monitor and wait for completion
	@./scripts/demo.sh check

test: ## Run every test suite inside disposable Docker containers
	@./scripts/test.sh all

test-go: ## Run Go control-plane tests in Docker
	@./scripts/test.sh go

test-worker: ## Run worker tests and TypeScript build in Docker
	@./scripts/test.sh worker

test-fixture: ## Run fixture tests and TypeScript build in Docker
	@./scripts/test.sh fixture

test-web: ## Run console tests and production build in Docker
	@./scripts/test.sh web

check: ## Validate shell scripts and the rendered Compose model
	@./scripts/test.sh shell
	@./scripts/test.sh compose

kind-up: ## Build images and create/update the local kind showcase cluster
	@CLUSTER="$(CLUSTER)" ./scripts/kind.sh up

kind-down: ## Delete the local kind showcase cluster
	@CLUSTER="$(CLUSTER)" ./scripts/kind.sh down

kind-images: ## Build and load current images into an existing kind cluster
	@CLUSTER="$(CLUSTER)" ./scripts/kind.sh images

kind-forward: ## Forward kind console and fixture ports until interrupted
	@CLUSTER="$(CLUSTER)" ./scripts/kind.sh forward

kind-status: ## Show Price Scout pods, services, PVCs, and recent events
	@CLUSTER="$(CLUSTER)" ./scripts/kind.sh status

kind-scale: ## Scale kind browser workers (usage: make kind-scale WORKERS=5)
	@CLUSTER="$(CLUSTER)" ./scripts/kind.sh scale "$(WORKERS)"

kind-rollout: ## Perform and follow a graceful worker rolling restart
	@CLUSTER="$(CLUSTER)" ./scripts/kind.sh rollout

kind-kill-worker: ## Delete one kind worker pod to demonstrate recovery
	@CLUSTER="$(CLUSTER)" ./scripts/kind.sh kill-worker
