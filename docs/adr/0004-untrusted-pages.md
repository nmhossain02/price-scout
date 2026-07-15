# ADR 0004: Treat pages and model output as untrusted

Status: accepted

The API rejects unsafe URLs and workers resolve the target again before opening
it. Stagehand constrains public-host navigation to the target domain, and the
worker rejects a final page URL outside the original origin. V1 does not
independently resolve every redirect hop, so deployments should enforce an
outbound-network policy as an additional boundary. Hostname policy does not pin
the destination IP across later browser requests, so that policy must also stop
DNS rebinding and access to cloud metadata/private networks. Model output may reference
snapshot node IDs and a small allowlist of read-only interaction methods; it
cannot provide JavaScript. Product identity, selected variant, currency, price
semantics, and stock are validated before an observation is eligible to alert.
Ambiguity fails closed into review.

Resolved cached targets are inspected before interaction and origin is checked
after each action. A stale target must still reach Stagehand for self-healing;
its replacement is exposed by the direct-action API only after execution, then
inspected immediately and rejected from persistence if unsafe. This limitation
is why browser isolation and outbound-network controls are part of the live-site
deployment boundary rather than optional hardening.

The local Chromium image uses `--no-sandbox`; its non-root, capability-free
container is the browser isolation boundary. The supplied manifests are a local
portfolio environment, not a production multi-tenant sandbox. Production
browsers must be separated from unrelated secrets and internal control-plane
network access.
