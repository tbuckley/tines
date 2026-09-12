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

## Human-review return: independent mixed acceptance and fail-closed telemetry

The expanded `pnpm --filter web test:usage-mixed` gate uses one independently enumerated manifest in `apps/web/test-fixtures/usage-mixed.mjs`, also exercised by the actual GET-handler test. It imports no production classifier, accumulator, or dimension resolver. The 2026-09-12 rerun completed 38 cases, 256 raw HTTP evidence pages, and 228 CLI invocations executing `node --import tsx src/index.ts` directly, plus default/error/manual-page/account-key/run-key probes. CI now runs this gate.

The manifest includes 143 finalized and 107 pending-at-cutoff facts: multiple active/archived/deleted/unknown projects, system/owned/deleted workflows, surviving/deleted starting states, distinct deleted runner IDs, three tiers and all four outcome categories. Twelve explicitly declared accounting cases cover provider/calculated/unknown-source amounts, zero, unpriced tokens, null/explicit-none/malformed records, invalid costs/tokens, complete/partial/missing rate bases, and pricing reasons. Historical orphan rows are injected with foreign keys disabled solely for fixture setup; they do not claim ordinary deletion APIs preserve those rows.

For every grouping/filter case, the gate independently checks scope versus matching counts, exact amounts, source portions, all token coverage/invalid counters, diagnostics, pricing reasons, rate identities/amounts/selection extrema, and exact priced-subset statistics. Every returned finalized item is compared with its declared accounting and dimensions before re-summing evidence into the report; pending items have an exact key allowlist and planted later secrets must be absent. Raw HTTP pages are checked for duplicate IDs before CLI deduplication can conceal them. The CLI runs JSON and text for usage and both evidence populations, and checks persisted rate references and ownership errors. Manual CLI paging exhausts all 107 pending records; the default finalized limit is asserted as 50.

This matrix exposed and fixed period evidence's deleted-versus-null project/runner/state predicates and missing workflow-label parity. Shared retained workflow expressions now preserve a stored workflow ID if its metadata is absent, but reject a live foreign workflow behind an owned corrupt fact. The same expression drives aggregation, pending matching, evidence filters/projection and retained-ID authorization; ordinary run-list filtering is unchanged. Workflow existence probes are primary-key lookups, not extra D1 statements.

The scale harness now refuses any request with missing SQL telemetry, checks the unfiltered aggregate's exact `ceil(N/5000) + 4` executions (two bearer queries, settings, pending count), and requires 3–30 queries on each evidence request. Counts above 49 still fail the larger stress aggregate. Restoring authorization-before-cursor-validation and restoring the old unknown-project predicate each failed the targeted handler test; both mutations were restored and followed by clean controls.

Machine-readable receipts are committed in [`receipts/usage-473/`](receipts/usage-473/): the mixed manifest, 10k exhaustion, 100k all-priced, candidate-100,001 match, and 210,001 no-match continuation. Fresh query controls measured **6 / 4**, **24 / 5→4**, **29 / 17**, and **47 / 23→4** aggregate/evidence executions respectively. Disabling the actual Worker's trace hook made the 10k harness fail with `Worker SQL telemetry absent`; restoring it passed. Deleting source CLI accounting-status forwarding also failed the real-worker matrix; the restored final control passed, including every printed finalized dimension/exact classification and aggregate source/diagnostic count. Manual CLI cursors now independently enumerate both 143 finalized (8 pages) and 107 pending (6 pages) records.

The final isolation extension also plants a foreign end-state reference in an owned finalized fact. It reproduced a leaked foreign label; finalized hydration now fences that metadata through its owning/system workflow. The exact pending allowlist still excludes all end-state facts. The final 100k all-priced receipt includes this additional joined fence; it adds no D1 execution.

Final local gates on the current-main merge tree: `pnpm check`, `pnpm test` (270 shared / 574 CLI / 1,675 web), `pnpm format:check`, native Worker build, and navigation performance pass. Each spend browser file passed independently: a11y 7, recovery 8, selection matrix 6, real ledger 4; a11y and real ledger were repeated after the end-state fence. The unsharded full-browser attempt was stopped after 228 cases following the same unrelated `dialog-pending.spec.ts` animation failure recorded by review v3. All three CI browser shards passed on implementation commit `bac1583`; final-head CI is a separate run and is not represented here as already passed.
