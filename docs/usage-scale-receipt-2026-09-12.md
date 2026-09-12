# Period usage native scale receipt — 2026-09-12

The current receipt measures the authenticated built Worker through Wrangler 4.130.0 local D1. `usage-scale.mjs` captures native `meta.rows_read` before kysely-d1 discards it, together with the actual compiled SQL and positional bindings. Earlier literal-SQL probes were not representative of the shipping planner and have been removed. The Worker binding **does** expose rows read; the Wrangler CLI's rendered output omits that metric.

| Dataset | Aggregate / evidence queries | Aggregate scan rows read | Evidence candidate rows read | Aggregate / evidence wall ms |
| --- | ---: | ---: | ---: | ---: |
| 10k sparse exhaustion | 6 / 4 | 70,008 | 10,000 | 208 / 131 |
| 100k all priced | 24 / 5 → 4 | 700,152 | 20,003 (two requested pages) | 781 / 145 → 155 |
| 100k all at one timestamp, no priced | 24 / 13 | 700,152 | 100,018 | 694 / 264 |
| 120,001, unique match beyond candidate 100k | 29 / 17 | 840,199 | 120,025 | 793 / 291 |
| 210,001, no match, bounded continuation | 47 / 23 → 4 | 1,470,343 | 210,043 | 1,257 / 392 → 133 |

Query counts include authentication, settings, pending count, and selected evidence hydration. The aggregate scan reads include metadata joins. Total **request** rows read (including all those extra queries) are recorded separately: 80,711 at 10k and 800,855 at 100k for aggregation; the two all-priced evidence requests read 110,404 and 110,405 respectively, including selected-row hydration. These complete totals must not be confused with candidate scan counts. Local wall times include telemetry/hash work and a 100ms log drain; they are observations, not production CPU measurements.

For 100k, the first aggregate page reads 35,007 rows and the last 35,001; the single-timestamp fixture gives the same result. Sparse first/last pages each read 10,001. Compare review v4's old 1,650,133 aggregate / 550,009 sparse scan reads: the new 700,152 / 100,018 totals eliminate growing prefix rescans. Every continuation replaces the original upper window bound with one `(timestamp, id) < (?, ?)` index seek, retaining the lower period bound, account fence, and pending-at-cutoff end predicate. Both public and internal sparse cursors use it.

The gate checks each actual aggregate page against `7 * (returned_rows + 2)` and each lean candidate page against `returned_rows + 2` on this fixed-metadata fixture. Thus a full N-row aggregate walk is bounded by `7 * (N + 3 * ceil(N/5000))` scan reads; a complete sparse walk by `N + 3 * ceil(N/10000)`. Complete unfiltered request reads are also capped at `8 * (N + ceil(N/5000)) + 1000` for aggregation and `N + candidate_reads + 1000` for each evidence request in this fixture, including hydration and authentication. It additionally checks exact query counts, sparse exhaustion, and a SHA-256 digest of **every ordered page's IDs** against an independently generated fixture order, including lookahead rows. The same 100k single-timestamp gate runs in CI. Missing query telemetry or missing/non-numeric rows-read metadata fails closed.

EXPLAIN runs in a separate, loopback-only local sidecar **after** measured requests. It prepares the exact captured SQL with the exact positional bindings for first and last aggregate/evidence pages and requires the shipped `agent_run_user_ended_idx`; no literal substitution or extra measurement SQL is injected into service requests. Plans and per-page native metadata are in the machine-readable receipts. Each statement remains below D1's 30-second duration limit. The 100k design allowance remains <=29 aggregate / <=30 sparse invocation queries against D1 Free's 50-query limit; larger stress fixtures are explicitly outside the supported 100k invocation gate.

Raw aggregate page JSON peaks at 2.34 MB on the all-priced fixture; sparse pages at 1.36 MB. Worker isolate heap remains a justified bound, not an inspector measurement: 100k all-priced typed samples have at most 3.2 MB reachable capacity / 6.4 MB across geometric allocations before collection. Those bounds are tested independently. Unpaginated group/rate identities still grow with historical cardinality; production has no scale tracing, per-page hashing, or retained trace logs.

Reproduce from the repository root (the script replaces only `apps/web/.wrangler-usage-scale`, never a remote database):

```sh
pnpm --filter web perf:usage --size=10000
pnpm --filter web perf:usage --size=100000 --all-priced
pnpm --filter web perf:usage --size=100000 --equal-time --no-priced
pnpm --filter web perf:usage --size=120001
pnpm --filter web perf:usage --size=210001 --no-priced
```

`--skip-build` is safe only when the built Worker already contains the source being measured. Each receipt includes compiled statements, bindings, ordered-ID hashes, native rows read/duration, EXPLAIN plans, query counts, response sizes, independent accounting/distribution oracles, and CLI reconciliation. The unique sparse result is `scale_100001`; the 210,001 no-match case exhausts in two requests with no skipped or duplicate rows. See [`receipts/usage-473/`](receipts/usage-473/).

## Human-review return: independent mixed acceptance and fail-closed telemetry

The expanded `pnpm --filter web test:usage-mixed` gate uses one independently enumerated manifest in `apps/web/test-fixtures/usage-mixed.mjs`, also exercised by the actual GET-handler test. It imports no production classifier, accumulator, or dimension resolver. The 2026-09-12 rerun completed 38 cases, 256 raw HTTP evidence pages, and 228 CLI invocations executing `node --import tsx src/index.ts` directly, plus default/error/manual-page/account-key/run-key probes. CI now runs this gate.

The manifest includes 143 finalized and 107 pending-at-cutoff facts: multiple active/archived/deleted/unknown projects, system/owned/deleted workflows, surviving/deleted starting states, distinct deleted runner IDs, three tiers and all four outcome categories. Twelve explicitly declared accounting cases cover provider/calculated/unknown-source amounts, zero, unpriced tokens, null/explicit-none/malformed records, invalid costs/tokens, complete/partial/missing rate bases, and pricing reasons. Historical orphan rows are injected with foreign keys disabled solely for fixture setup; they do not claim ordinary deletion APIs preserve those rows.

For every grouping/filter case, the gate independently checks scope versus matching counts, exact amounts, source portions, all token coverage/invalid counters, diagnostics, pricing reasons, rate identities/amounts/selection extrema, and exact priced-subset statistics. Every returned finalized item is compared with its declared accounting and dimensions before re-summing evidence into the report; pending items have an exact key allowlist and planted later secrets must be absent. Raw HTTP pages are checked for duplicate IDs before CLI deduplication can conceal them. The CLI runs JSON and text for usage and both evidence populations, and checks persisted rate references and ownership errors. Manual CLI paging exhausts all 107 pending records; the default finalized limit is asserted as 50.

This matrix exposed and fixed period evidence's deleted-versus-null project/runner/state predicates and missing workflow-label parity. Shared retained workflow expressions now preserve a stored workflow ID if its metadata is absent, but reject a live foreign workflow behind an owned corrupt fact. The same expression drives aggregation, pending matching, evidence filters/projection and retained-ID authorization; ordinary run-list filtering is unchanged. Workflow existence probes are primary-key lookups, not extra D1 statements.

The scale harness now refuses any request with missing SQL telemetry, checks the unfiltered aggregate's exact `ceil(N/5000) + 4` executions (two bearer queries, settings, pending count), and requires 3–30 queries on each evidence request. Counts above 49 still fail the larger stress aggregate. Restoring authorization-before-cursor-validation and restoring the old unknown-project predicate each failed the targeted handler test; both mutations were restored and followed by clean controls.

Machine-readable receipts are committed in [`receipts/usage-473/`](receipts/usage-473/): the mixed manifest, 10k exhaustion, 100k all-priced, candidate-100,001 match, and 210,001 no-match continuation. Fresh query controls measured **6 / 4**, **24 / 5→4**, **29 / 17**, and **47 / 23→4** aggregate/evidence executions respectively. Disabling the actual Worker's trace hook made the 10k harness fail with `Worker SQL telemetry absent`; restoring it passed. Deleting source CLI accounting-status forwarding also failed the real-worker matrix; the restored final control passed, including every printed finalized dimension/exact classification and aggregate source/diagnostic count. Manual CLI cursors now independently enumerate both 143 finalized (8 pages) and 107 pending (6 pages) records.

The final isolation extension also plants a foreign end-state reference in an owned finalized fact. It reproduced a leaked foreign label; finalized hydration now fences that metadata through its owning/system workflow. The exact pending allowlist still excludes all end-state facts. The final 100k all-priced receipt includes this additional joined fence; it adds no D1 execution.

Final local gates on the current-main merge tree: `pnpm check`, `pnpm test` (270 shared / 574 CLI / 1,675 web), `pnpm format:check`, native Worker build, and navigation performance pass. Each spend browser file passed independently: a11y 7, recovery 8, selection matrix 6, real ledger 4; a11y and real ledger were repeated after the end-state fence. The unsharded full-browser attempt was stopped after 228 cases following the same unrelated `dialog-pending.spec.ts` animation failure recorded by review v3. All three CI browser shards passed on implementation commit `bac1583`; final-head CI is a separate run and is not represented here as already passed.

## Final cursor-seek verification

Restoring the pre-fix aggregate service fails the native 10k gate at **40,000 rows read for 5,000 returned**. Restoring the pre-fix evidence service fails the 100k single-timestamp gate at **20,001 for 10,001**. Removing `rows_read` from the actual Worker trace fails with `Worker rows_read telemetry absent or invalid`. All mutations were restored, followed by a rebuilt 10k control and the full equal-time CI command; machine-readable mutation results are alongside the receipts.

Fresh final-source gates pass: `pnpm check`, full `pnpm test` (270 shared / 574 CLI / 1,676 web), formatting, built Worker/CLI, navigation performance, the 38-case real-worker/source-CLI mixed matrix, and all five scale datasets above. The new 10,003-row unit regression independently pins large timestamp ties, exact totals, sparse matching beyond an internal page, public cursor order, both period edges, and pending-at-cutoff inclusion. The journal's incorrect rows-read limitation was corrected to distinguish the CLI formatter from the native Worker binding.

Each existing spend browser spec also passes independently on the final source against the real local API: `spend-a11y.spec.ts` 7 cases at 1440/390/320 with keyboard/modal assertions, `spend-recovery.spec.ts` 8, `spend-matrix.spec.ts` 6, and `spend.spec.ts` 4. Final root `pnpm build` passes. CI independently runs all browser shards, the mixed matrix, and the new single-timestamp scale gate.
