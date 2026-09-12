# Finalized period usage decision — 2026-09-11

Period reporting is an additive ledger over retained `agent_run` rows. Unlike the historical observation-time quota description, report membership is attributed once by finalized `ended_at` in a half-open UTC interval. Pending attempts are visible only as counts at the cutoff and never borrow eventual usage or outcome. This decision does not change producer measurement, pricing, quota enforcement, or reconstruct absent history.

The canonical implementation and operator reconciliation procedure are documented in [`docs/usage.md`](../../docs/usage.md). Group dimensions use current project/workflow metadata, starting-state identity, and the recorded run outcome. Distribution statistics describe priced finalized attempts and use nearest-rank p95.

The hardened v2 evidence contract preserves retained raw identities, freezes resolved bounds and timezone provenance in cursors, adds independently summable accounting evidence, and bounds aggregate/sparse query work. It intentionally rejects in-flight v1 period cursors with a restart remedy. This finalized-period contract supersedes the historical observation-time/repricing aspiration below for reporting only; it does not change producer pricing or budget enforcement.
