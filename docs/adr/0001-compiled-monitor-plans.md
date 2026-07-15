# ADR 0001: Compile agent work into deterministic monitor plans

Status: accepted

Stagehand's agentic discovery is valuable when a monitor is created or a site
changes, but invoking a model on every scheduled check increases cost and makes
behavior harder to reproduce. Price Scout stores preparation actions and
extraction strategies in a versioned plan. Routine executions replay that plan
with inference disabled. Model work creates a candidate revision and cannot
mutate an active plan in place.
