# Runbook: domain blocking and rate limiting

## Signal

Executions are classified as `blocked`, responses contain 403/429, or a challenge
page replaces the product page.

## Response

1. Pause each affected monitor; Price Scout does not bypass challenge pages.
2. Inspect execution evidence and recent request frequency, then increase those
   monitors' intervals before resuming.
3. Confirm the target remains within the public-page and site-policy boundary.
4. Choose and enforce a manual cooldown before resuming. Browser checks in v1 do
   not implement `Retry-After` scheduling or per-domain exponential backoff.
5. If blocking continues, keep the individual monitors paused and preserve the
   execution evidence for review.
