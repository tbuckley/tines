# Period usage native scale receipt — 2026-09-12

Measured on macOS with Wrangler 4.130.0 local D1, the shipped migrations, and `apps/web/scripts/usage-scale.mjs`. Wall time includes a fresh Wrangler CLI process per query, so it is deliberately conservative and is not Worker CPU time.

| Dataset/path | Queries | Returned/examined rows | Max JSON page | Wall time |
| --- | ---: | ---: | ---: | ---: |
| 10k aggregate | 2 | 10,001 including lookahead | 2,051,755 B | 1.61 s |
| 10k sparse exhaustion | 1 | 10,000 | 1,455,096 B | 0.81 s |
| 100k aggregate | 20 | 100,019 including lookahead | 2,051,774 B | 16.70 s |
| 100k sparse exhaustion | 10 | 100,000 | 1,455,255 B | 8.59 s |
| 120,001 sparse match | 11 | 110,000 | 1,455,298 B | 9.67 s |

The final instrumented built-Worker rerun measured the actual Kysely executions, including bearer authentication and period metadata: 6 aggregate / 4 evidence queries at 10k, 24 aggregate / 5 then 4 evidence queries at 100k all-priced, and 29 aggregate / 17 evidence queries for the candidate-100,001 sparse match. The 210,001 no-priced stress case measured 47 aggregate queries and two bounded evidence requests of 23 then 4 queries; the first returned an empty continuation and the second proved exhaustion without duplicates or skips. The harness enables this counter only through its local `USAGE_SCALE_SQL_TRACE=1` Worker variable and fails above 49 aggregate or 30 evidence queries; production does not set the variable. These measured shipping-path counts replace the earlier inferred-only query accounting.

The unique priced row in the last case was `scale_100001`, proving a match beyond 100,000 descending candidates without a skipped equal-time row. Aggregate paging used 10 equal-time rows per timestamp. The 100k service bound is 27 queries, 29 including bearer authentication, leaving 21 below D1 Free's 50-query invocation limit. Sparse evidence is capped at 30 including authentication/hydration/metadata. The 120,001 aggregate walk is intentionally outside the supported 100k invocation gate and took 25 data pages.

The harness now also boots the built authenticated Worker and compares it with an oracle derived directly from the generated row numbers—not from either API response. It asserts finalized/priced/unpriced/unreported counts, exact cost, median, nearest-rank p95, max, pending count, and the sum of every tier group. On sparse datasets it additionally spawns the built source CLI for both JSON and text `runs list --all-pages`, independently re-sums every evidence item's accounting cost, requires cursor exhaustion, and verifies the accounting/rate disclosure. The all-priced 100k case deliberately does not serialize all 100k evidence rows through one invocation; that case is the aggregate/distribution and memory-bound gate, while the sparse datasets are the complete evidence/CLI gate.

Both aggregate and evidence plans used `agent_run_user_ended_idx (user_id=? AND ended_at>? AND ended_at<?)`; joined issue and starting-state metadata used primary-key indexes. Pending used `agent_run_user_time_idx (user_id=? AND created_at<?)`. Every individual query remained far below D1's 30-second duration limit.

Wrangler local emitted `meta.duration` but not production D1's `meta.rows_read`, so this receipt does not invent a rows-read figure: returned rows and native indexed plans are the available local evidence. Worker isolate heap was likewise unavailable. The conservative 100k all-priced accumulator bound is 3.2 MB reachable typed-sample capacity and 6.4 MB across all geometric allocations before collection, verified separately by the 100k shared test; raw page JSON peaked at 2.06 MB. Even adding parsed strings, dictionaries, response serialization, and sort workspace leaves substantial headroom under the 128 MB isolate limit for the supported ordinary low-cardinality dataset, but this is a justified bound rather than an inspector measurement.

Reproduce:

```sh
pnpm --filter web perf:usage --size=10000
pnpm --filter web perf:usage --size=100000
pnpm --filter web perf:usage --size=120001
```

The script replaces only `apps/web/.wrangler-usage-scale`, applies shipped migrations, never selects a remote database, and prints the complete JSON receipt including EXPLAIN rows and authenticated oracle results. Unpaginated groups/rate identities remain proportional to their historical cardinality and are not silently capped.
