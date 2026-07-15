# Runbook: upgrade

1. Back up Postgres and the artifact volume.
2. Read Stagehand and schema release notes; monitor plans record their Stagehand
   and validator versions.
3. Build immutable images and run unit, fixture, redesign, and redelivery tests.
4. Apply forward-only migrations before rolling stateless services.
5. Drain workers, roll them gradually, and watch JetStream consumer pending and
   redelivery counts alongside execution failure classes.
6. Run a deterministic warm check against an existing plan before resuming the
   scheduler.
7. Roll back stateless images on regression; never reverse a destructive schema
   migration without a tested restore.
