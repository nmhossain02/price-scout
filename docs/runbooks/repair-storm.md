# Runbook: repair storm

## Signal

Repair-request rate rises sharply, many checks fail on the same active revision,
or inference usage increases unexpectedly.

## Response

1. Group failures by monitor and failed generation.
2. Verify the repair uniqueness constraint elected one attempt per pair.
3. Group failures by origin, then pause each affected monitor individually; v1
   has no domain-wide pause control.
4. Inspect old and candidate evidence and verify which revision is current
   before resuming.
5. Reject candidates with currency, identity, variant, or price ambiguity.
6. Resume checks gradually after one deterministic healed replay succeeds.

Never bypass validation to clear a queue; a false alert is worse than a delayed
observation.
