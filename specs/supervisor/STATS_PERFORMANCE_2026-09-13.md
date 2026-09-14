# Weekly stats performance decision (2026-09-13)

Weekly stage statistics remain an on-request calculation. Production-shaped isolated measurement put the authenticated `/agents` p95 below the one-second threshold for considering a rollup, while profiling identified repeated analytical preparation for each change marker as the dominant CPU cost.

The loader therefore prepares visits, run bindings, state groups and received-back target groups once. The base report and every marker window evaluate that immutable prepared index. Cross-type event reads use their user/type/time bound without SQL ordering and are sorted by `(created_at, id)` in memory so the existing D1 index remains usable.

Change batching remains a forward, first-event-anchored scan with a 60-second threshold. Only the last 20 completed groups are returned, but every relevant candidate row in the requested window must still be read: an early-stop or raw-row cap would change group boundaries and evidence IDs. The two-window lifecycle horizon is retained even for `compare=none`, because entries from the earlier window can determine synthetic exits and recovered outcomes.

Sent-back evidence stays lazy. Comment reads select only response fields, stop at the newest relevant transition and split issue IDs below D1's binding limit. Prompt lifecycle reads retain every event for generations created for the selected stage, including metadata-poor updates and deletions and the current-row fallback.

Run `pnpm --filter web perf:stats` for the production-shaped isolated Worker/D1 probe, or `pnpm --filter web perf:stats:cpu` for the deterministic preparation-only diagnostic. Timing is diagnostic, not a CI threshold; complete-output tests carry correctness. A rollup requires a new design decision only if an authenticated, isolated or preview `/agents` sample exceeds one-second p95 after this optimization.

The retained Worker/D1 probe now owns `perf:stats`; the former CPU-only probe is
`perf:stats:cpu`. On the implementation checkout after review fixes (macOS managed runner,
ten sequential samples), the built isolated Worker measured at 1× irrelevant-event volume:
API unfiltered 35.5 ms median / 65.9 ms p95; project-filtered 32.7 / 39.6 ms;
`compare=none` 23.5 / 37.3 ms; lazy evidence 10.2 / 17.7 ms; authenticated `/agents`
665.0 / 784.0 ms. At 10×, the same figures/evidence hashes, query counts, transfer counts
and native rows-read were preserved: API unfiltered 37.9 / 76.1 ms; project 26.2 / 32.2 ms;
`compare=none` 25.9 / 30.7 ms; evidence 9.0 / 11.3 ms; `/agents` 552.8 / 696.0 ms.
The API read 8,840 rows unfiltered and 8,536 scoped; lazy evidence read 388 and transferred
90 at both volumes. The event plan was
`SEARCH event USING INDEX event_user_type_created_idx (user_id=? AND type=? AND created_at>? AND created_at<?)`.
The retained same-fixture baseline mode reproduces the old marker loop inside the built
Worker. A three-sample acceptance run measured unfiltered API median 700.0 ms before versus
37.2 ms after (18.8×), project 608.8 versus 34.1 ms (17.9×), and `compare=none` 693.6
versus 33.1 ms (21.0×), with identical full-output hashes and the same query/transfer counts.
The page remains below the one-second rollup trigger. These isolated totals are not a
promise about production network latency; the pre-change research sample on its earlier
fixture was 279 / 316 ms for `/agents` and 323.3 ms for the marker-bearing loader.

On 2026-09-14, `/agents` became the operational Now landing path and stopped calculating or
serializing weekly statistics. The unchanged weekly computation now begins only when the
default-closed State analysis disclosure is opened in Analysis. Historical `/agents`
measurements above include the former eager weekly calculation and remain preserved as such.
