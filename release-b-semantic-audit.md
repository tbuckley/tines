# Release B semantic audit

Date: 2026-09-22

## Retired runtime paths

- `apps/web/src/lib/server/api/context.ts`: matching, sorting, deduplication,
  journal selection, summary, resolved environment, and launch guidance use
  the exact project/state/issue target. No recursive state-chain query or root
  journal resolver remains.
- `apps/web/src/lib/server/api/workflows.ts`: every non-null
  `states[].inherits_from` value is rejected before allocation; affirmative
  `force_clear_inheritance` aliases are rejected at update/delete service
  boundaries. Pointer mutation, inheritance events, child dependency guards,
  and duplication passthrough are removed. Context/project deletion guards,
  ordinary and Standard workflow behavior remain.
- `apps/web/src/lib/server/api/issues.ts`, starters, and library compilation:
  state responses retain a nullable compatibility field but do not expose live
  pointer state or resolve it.
- `packages/cli/src/commands/workflows.ts`: the bases command, pair/grouping
  resolver, and extra library fetch from show/create/edit are removed. Show is
  exact-state and the newline-name regression exits 0.
- `packages/cli/src/commands/state-retirement.ts`: new A inventory/hold/
  prepare/apply/rollback authority is absent. Historical inventory inspection,
  receipt read/verify, and explicit release remain.
- `apps/web/src/lib/server/state-retirement/service.ts`: retired A operations
  return stable HTTP 410 `state_retirement_operation_retired` before work.

## Retained historical or compatibility paths

- The nullable `workflow_state.inherits_from_state_id` column and old migration
  filenames remain. Historical A inventory/receipt/verification code remains
  available for owner inspection and exact-target verification; new topology
  mutation is retired.
- The `inherits_from` and `inherited_from` response/type shapes remain where
  package compatibility requires them, but B runtime emits null and rejects
  non-null workflow input.
- Release A migration `0033_state_retirement.sql` remains in the deployed
  ordering. Release B migration `0042_state_inheritance_retired.sql` is
  fail-closed on both leftover workflow pointers and unresolved recorded
  pointers, installs a singleton barrier record, and permanently rejects
  non-null pointer INSERT/UPDATE while allowing null writes.
- Historical A tests that require populated pointers are explicitly skipped;
  B migration and service regressions cover the retained inspection/barrier
  contract instead of reintroducing an operational inheritance path.

## Verification and unresolved items

- `pnpm check`: passed; migration numbering accepts the mainline-owned 0041
  gap and validates local 0042.
- `pnpm format:check`: passed after formatting the changed files.
- Web targeted migration/workflow/library tests: passed; full web suite passed
  (152 files, 2,136 tests; 2 files and 79 tests skipped as historical A).
- CLI workflow regression and full CLI suite: passed after updating command
  help snapshots; the full suite is 50 files / 702 tests.
- Repository build and local E2E remain parent assembly obligations if the
  parent release run requires them. No production deployment, live cutover,
  migration-barrier removal, or post-deployment proof was performed in this
  slice.
