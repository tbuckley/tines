# Weekly stats performance decision (2026-09-13)

Weekly stage statistics remain an on-request calculation. Production-shaped isolated measurement put the authenticated `/agents` p95 below the one-second threshold for considering a rollup, while profiling identified repeated analytical preparation for each change marker as the dominant CPU cost.

The loader therefore prepares visits, run bindings, state groups and received-back target groups once. The base report and every marker window evaluate that immutable prepared index. Cross-type event reads use their user/type/time bound without SQL ordering and are sorted by `(created_at, id)` in memory so the existing D1 index remains usable.

Change batching remains a forward, first-event-anchored scan with a 60-second threshold. Only the last 20 completed groups are returned, but every relevant candidate row in the requested window must still be read: an early-stop or raw-row cap would change group boundaries and evidence IDs. The two-window lifecycle horizon is retained even for `compare=none`, because entries from the earlier window can determine synthetic exits and recovered outcomes.

Sent-back evidence stays lazy. Comment reads select only response fields, stop at the newest relevant transition and split issue IDs below D1's binding limit. Prompt lifecycle reads retain every event for generations created for the selected stage, including metadata-poor updates and deletions and the current-row fallback.

Run `pnpm --filter web perf:stats` for the production-shaped isolated Worker/D1 probe, or `pnpm --filter web perf:stats:cpu` for the deterministic preparation-only diagnostic. Timing is diagnostic, not a CI threshold; complete-output tests carry correctness. A rollup requires a new design decision only if an authenticated, isolated or preview `/agents` sample exceeds one-second p95 after this optimization.

The retained Worker/D1 probe now owns `perf:stats`; the former CPU-only probe is
`perf:stats:cpu`. On the implementation checkout (macOS managed runner, ten sequential
samples), the built isolated Worker measured: API unfiltered 31.0 ms median / 51.3 ms
p95; project-filtered 20.8 / 22.6 ms; `compare=none` 20.4 / 22.6 ms; lazy evidence
6.5 / 14.2 ms; authenticated `/agents` 546.9 / 675.2 ms. The event plan was
`SEARCH event USING INDEX event_user_type_created_idx (user_id=? AND type=? AND created_at>? AND created_at<?)`.
The page remains below the one-second rollup trigger. These isolated totals are not a
promise about production network latency; the pre-change research sample on its earlier
fixture was 279 / 316 ms for `/agents` and 323.3 ms for the marker-bearing loader.
