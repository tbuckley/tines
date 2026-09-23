# Decision: immutable attempt-level Codex estimates (2026-09-11)

> Amended 2026-09-12 by [Local producer proof](LOCAL_PRODUCER_PROOF_2026-09-12.md), which permits
> existing short-band rates only when exact-thread request deltas prove every request is short.
>
> User-entered rates and bounded explicit repricing are defined by [USER_MODEL_RATES_2026-09-22.md](USER_MODEL_RATES_2026-09-22.md).

Tines calculates supported Codex runs centrally at finish from a small append-only exact-model catalog and persists the complete reproducing basis in `agent_run.usage`. The estimate uses the catalog version adopted when the run was claimed. Provider dollars always win; unsupported or incomplete evidence remains Unpriced. The daemon reports the launch argument and cumulative JSONL token evidence, while the server repeats normalization and owns rates.

This decision supersedes the historical Codex-unpriced, editable-override, retroactive-current-window repricing, and enforcement assumptions in SPEC §Usage for this deliverable. It introduces neither a usage ledger nor budget enforcement. Full policy, sources, limitations, and rollout checks live in [the maintained guide](../../docs/codex-pricing.md).
