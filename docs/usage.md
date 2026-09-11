# Period usage

`GET /api/v1/usage` and `tines usage` report retained, finalized run cost for a period. The web view is under **Agents → Spend** and defaults to the last seven days; the API and CLI default to Today.

## Accounting contract

Membership is `ended_at >= from AND ended_at < to`. Completed, failed, canceled, timed-out, and never-started failed attempts count when finalized. Runs pending at the exclusive cutoff are counted separately and contribute no usage. Today begins at midnight in `supervisor_settings.budget.timezone`, with UTC fallback; 7d and 30d are rolling 168- and 720-hour windows. Responses contain resolved UTC bounds, timezone/source, generation time, `finalized_by_ended_at_v1`, and the current-metadata attribution basis.

A finite nonnegative `cost_usd`, including zero, is priced. Otherwise, any finite nonnegative token field, including zero, is unpriced; a run with neither is unreported. Dollars are summed without row rounding and returned as exact decimal strings plus numeric projections. Each token class has its own sum and reporting count. Coverage is Complete, Partial, Unknown, or No runs. Provider, calculated, and unknown-source portions remain separate; calculated rate identities come from immutable per-run pricing. List-price estimates are not invoices or subscription usage, and budgets are not enforced.

Distributions use priced finalized per-run costs, including explicit zero. Mean and median use their conventional definitions; p95 is nearest rank (`ceil(.95*n)`); maximum is always returned. Samples below 20 are labelled small, where p95 equals maximum. These are per-attempt costs, not issue lifetime or completion-cohort costs.

Project attribution uses the issue's current project, including archived projects. Starting-state workflow identity is preferred, with current issue workflow as the disclosed fallback when old state metadata is gone. Recorded outcomes are Advanced, Stalled, Interrupted, or Unknown. Metadata can change between requests; this is retained-history reconciliation, not an immutable metadata snapshot.

## Filters and reconciliation

Usage supports `project`, `workflow`, workflow-qualified `state`, `runner`, `tier`, recorded `outcome`, and `accounting_status`, grouped with `by=project|workflow|state|outcome|runner|tier`. `unknown` selects a missing identity. `scope_total` applies only project/window; `matching_total` and groups apply analytical filters. Pending counts cannot apply future outcome or price status and say so explicitly.

```sh
tines usage --window 7d --project Tines --by state --json > usage.json
tines runs list --population finalized \
  --from 2026-09-04T12:00:00.000Z --to 2026-09-11T12:00:00.000Z \
  --project Tines --all-pages --json > runs.json
```

Use the exact `evidence_filters` returned by the report, walk every `next_cursor` (manual paging above the CLI's 10,000-item safety bound), and compare full-precision fields rather than screen-rounded dollars. A preset is frozen by the report's returned bounds; metadata/history must remain unchanged during multi-request enumeration for exact reconciliation.
