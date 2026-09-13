# Weekly stats performance decision (2026-09-13)

Weekly stage statistics remain an on-request calculation. Production-shaped isolated measurement put the authenticated `/agents` p95 below the one-second threshold for considering a rollup, while profiling identified repeated analytical preparation for each change marker as the dominant CPU cost.

The loader therefore prepares visits, run bindings, state groups and received-back target groups once. The base report and every marker window evaluate that immutable prepared index. Cross-type event reads use their user/type/time bound without SQL ordering and are sorted by `(created_at, id)` in memory so the existing D1 index remains usable.

Change batching remains a forward, first-event-anchored scan with a 60-second threshold. Only the last 20 completed groups are returned, but every relevant candidate row in the requested window must still be read: an early-stop or raw-row cap would change group boundaries and evidence IDs. The two-window lifecycle horizon is retained even for `compare=none`, because entries from the earlier window can determine synthetic exits and recovered outcomes.

Sent-back evidence stays lazy. Comment reads select only response fields, stop at the newest relevant transition and split issue IDs below D1's binding limit. Prompt lifecycle reads retain every event for generations created for the selected stage, including metadata-poor updates and deletions and the current-row fallback.

Run `pnpm --filter web perf:stats` for the deterministic production-shaped CPU probe. It compares repeated preparation with one shared preparation over 524 issues, 28 states, 1,525 runs and 40 marker-style windows. Timing is diagnostic, not a CI threshold; complete-output tests carry correctness. A rollup requires a new design decision only if an authenticated, isolated or preview `/agents` sample exceeds one-second p95 after this optimization.
