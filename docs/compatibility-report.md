# Live-site compatibility qualification template

This report is intentionally manual and dated. Live retailers change without
notice and never gate deterministic CI.

No third-party retailer has been qualified for this portfolio release. The
deterministic fixture is the only compatibility target exercised in CI. Before
claiming support for a live site, record it here using this table:

| Profile | Site and URL | Checked at | Compile | Warm replay | Evidence | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| Server-rendered storefront | TBD after current policy review | — | — | — | — | — |
| Dynamic variant-heavy storefront | TBD after current policy review | — | — | — | — | — |
| Marketplace-style page | TBD after current policy review | — | — | — | — | — |

For each page, record the exact variant instruction, displayed price semantics,
currency, stock result, model, browser provider, action count, Price Scout
inference operations during the warm run, and a link to retained evidence. This
is a logical operation count, not a count of provider HTTP requests. For live
repairs, a nonzero value confirms that inference was initiated, but Stagehand
3.7 does not expose a public exact self-heal call counter. Stop and mark the site
unsupported if access requires authentication, challenge bypass, cart mutation,
or behavior contrary to the site's current policy.
