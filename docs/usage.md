# Usage and evidence

`GET /api/v1/usage` and `tines usage` report retained, finalized run cost for a period. The web view is under **Agents → Analysis → Spend** and defaults to the last seven days; the API and CLI default to Today.

Every report now returns signed, owner-bound scopes for its project total, matching subtotal, pending population, and groups. Open **View contributing issues and runs**, or use `GET /api/v1/usage/evidence`, to enumerate the complete direct issue/run contribution. Evidence defaults to exact stored cost descending; unpriced contributions sort last in both directions. Cost ties use newest evidence then raw ID, and every page returns whole-selection totals rather than a sum of that visible page. Signed cursors bind the scope, evidence kind, population, member and ordering. Scopes freeze resolved selection and cutoff, not retained rows or current labels; key rotation requires restarting from the report.

`mode=issue&issue=<id>` and `tines usage --issue Tines/123` report **Lifetime through now** across every retained direct attempt, stage and retry. Child and dependency runs are never traversed. Attempts created at the cutoff are absent; attempts ending at or after it are pending, and the pending projection cannot expose facts learned later. A retained raw issue ID remains readable when its owned runs survive but current metadata does not. A measured zero is `$0.00`, absent dollars are Unknown, and an issue without attempts says **No agent runs**.

`mode=cohort&workflow=<id>` and `tines usage --cohort --workflow Engineering` report distinct issues with a recorded entry into a selected terminal state in `[from,to)`. Omission selects every actual done state; repeat `done_state`/`--done-state` to select exact states. Membership uses the latest qualifying entry per issue, while accounting includes every retained direct attempt created before `to`, including pre-window research, retries, pending attempts, and zero-run issues. Known-dollar and attempt means divide by all cohort issues. A fully priced issue has at least one finalized attempt, all finalized attempts priced, and no pending attempt. Reopening is observed separately through the signed `observed_through` cutoff. Cohort costs are not additive to period spend.

```sh
tines usage --issue Tines/123
tines usage --cohort --workflow Engineering --window 7d
tines usage --cohort --workflow wf_ID --from 2026-09-01 --to 2026-09-08 --done-state wfs_CLOSED
tines usage --window 7d --by workflow --json
tines usage --scope "$SCOPE" --evidence issues --sort cost --direction desc
tines usage --scope "$SCOPE" --evidence runs --member iss_123 --all-pages --json
tines usage --scope "$SCOPE" --evidence runs --population pending
```

Period, issue-lifetime, cohort, and scope-replay inputs are mutually exclusive. Evidence-only options require `--scope --evidence`; invalid combinations fail before name resolution or an API request. Completion-event cohorts and all-issue means are intentionally not inferred from current state.

Use the signed scope printed by a cohort report to reproduce every denominator and numerator: `tines usage --scope TOKEN --evidence issues --all-pages --json` lists all members including no-run issues, `--evidence runs --member iss_ID` lists finalized cutoff attempts, `--population pending` lists attempts still pending at the cutoff without later facts, and `--evidence entries` audits retained qualifying, chosen, reopening, excluded, and unclassifiable entry facts. Retained history can be partial or unavailable; current state is never substituted. Direct costs exclude child and dependency runs, may include attempts before the completion window, and reflect recorded provider/list prices rather than an invoice.

The Now view is operational and does not depend on usage accumulating. Analysis presents Spend before a default-closed, independently scoped weekly State analysis. Spend keeps its project scope independent from the global project focus and records project, workflow, breakdown, period, Custom bounds, and sort in the URL, so reload and browser Back/Forward restore the same report selection. Changing project resets workflow narrowing to All; changing sort only reorders the current groups. Custom ranges require both From and exclusive To before a request is made.

An initial failure replaces the report with a Retry action. A failed manual refresh may retain only the report for the same selection and labels it with that report's original generated time and resolved bounds. Missing usage is shown as Unknown or Partial—not `$0`—and waiting cannot repair a navigation or request failure.

## Accounting contract

Membership is `ended_at >= from AND ended_at < to`. Completed, failed, canceled, timed-out, and never-started failed attempts count when finalized. Runs pending at the exclusive cutoff are counted separately and contribute no usage. Today begins at midnight in `supervisor_settings.budget.timezone`, with UTC fallback; 7d and 30d are rolling 168- and 720-hour windows. Responses contain resolved UTC bounds, timezone/source, generation time, `finalized_by_ended_at_v1`, and the current-metadata attribution basis.

A finite nonnegative `cost_usd`, including zero, is priced. Otherwise, any finite nonnegative token field, including zero, is unpriced; a run with neither is unreported. Dollars are summed without row rounding and returned as exact decimal strings plus numeric projections. Each token class has its own sum and reporting count. Coverage is Complete, Partial, Unknown, or No runs. Provider, calculated, and unknown-source portions remain separate; calculated rate identities come from immutable per-run pricing. List-price estimates are not invoices or subscription usage, and budgets are not enforced.

Distributions use priced finalized per-run costs, including explicit zero. Mean and median use their conventional definitions; p95 is nearest rank (`ceil(.95*n)`); maximum is always returned. Samples below 20 are labelled small, where p95 equals maximum. These are per-attempt costs, not issue lifetime or completion-cohort costs.

Project attribution uses the issue's current project, including archived projects. Starting-state workflow identity is preferred, with current issue workflow as the disclosed fallback when old state metadata is gone. Recorded outcomes are Advanced, Stalled, Interrupted, or Unknown. Stored IDs remain distinct when their metadata label is deleted and are rendered as `Unknown/deleted … (<id>)`; explicit `unknown` selects a null stored identity instead. An owned retained ID is accepted as a filter, while another account's ID receives the same 404 as a nonexistent ID. Metadata can change between requests; this is retained-history reconciliation, not an immutable metadata snapshot. Deleted names and a deleted starting state's original workflow are genuinely unrecoverable and are never invented. Normal runner deletion also removes that runner's ended run facts.

## Filters and reconciliation

Usage supports `project`, `workflow`, workflow-qualified `state`, `runner`, `tier`, recorded `outcome`, and `accounting_status`, grouped with `by=project|workflow|state|outcome|runner|tier`. `unknown` selects a missing identity. `scope_total` applies only project/window; `matching_total` and groups apply analytical filters. Pending counts cannot apply future outcome or price status and say so explicitly.

```sh
tines usage --window 7d --project Tines --by state --json > usage.json
tines runs list --population finalized \
  --from 2026-09-04T12:00:00.000Z --to 2026-09-11T12:00:00.000Z \
  --project Tines --all-pages --json > runs.json
```

Use the signed `scope` fields for new detail views. The older `scope_evidence_filters`, `matching_evidence_filters`, and `pending_evidence_filters` remain available; `evidence_filters` remains an alias for matching finalized evidence. Existing `/runs` chains use `usage-runs-v2` and ordinary non-period run cursors remain unchanged.

Finalized evidence adds `usage_dimensions` and `usage_accounting`. Sum `cost_exact`, normalized per-class token values, source portions, diagnostics and pricing reasons to independently reproduce aggregate counters without reparsing malformed historical JSON. Pending evidence includes only structural dimensions and `accounting_status: pending`; it never reveals later usage, outcome, end/error or pricing facts. Bounds require real calendar dates or explicit-offset timestamps, evidence limits are strict integers from 1 through 100, and invalid/contradictory values return actionable 422 errors.

Aggregation processes finalized facts in 5,000-row pages and retains only exact priced samples; sparse accounting evidence examines at most 20 pages of 10,000 lean candidates per request, returning a continuation rather than spending an unbounded request budget. The supported and gated target is 100,000 period rows with ordinary low-cardinality dimensions. Work remains linear above that, while an unpaginated response is inherently proportional to distinct groups and historical rate identities; groups are never silently truncated.

Reproduce the native local D1 query plans, page sizes, equal-time keyset walk, authenticated built-worker totals/evidence, pending count, and exact source-CLI/HTTP reconciliation with `pnpm --filter web perf:usage --size=100000`. Add `--all-priced` for the 100,000-priced-run distribution path; use `--size=120001` without it for the unique priced match beyond 100,000 candidates, or `--size=210001 --no-priced` for an allowance-limited empty evidence continuation and sparse exhaustion. The script creates and replaces only `apps/web/.wrangler-usage-scale`, applies the shipped migrations, and prints a JSON receipt; it never addresses a remote database or inherits `TINES_API_URL`. Native Worker telemetry records actual bound-query `rows_read`, ordered page-ID hashes, durations and query counts; EXPLAIN uses those exact SQL statements and bindings in a separate local probe. Add `--equal-time --no-priced` at 100k to exercise a single-timestamp population. `authenticated_worker.elapsed_ms` measures the shipping aggregate path including local instrumentation and log draining; memory remains the documented conservative typed-sample bound rather than an isolate-inspector measurement.

The independent mixed ledger acceptance gate is `pnpm --filter web test:usage-mixed`.
It builds the local Worker, seeds only `.wrangler-usage-mixed`, and executes the CLI
from TypeScript source against an explicit localhost URL. Its shared manifest also
runs through the GET-handler unit tests. It covers full finalized and pending
paging, retained/deleted/unknown dimensions, accounting diagnostics and rate
portions, API/run-key isolation, and CLI JSON/text reconciliation. The fixture's
orphan references model historical storage; normal deletion may cascade instead.
