# Automation default amendment — 2026-09-09

Tom Buckley approved: “Once I add a runner, it's ok to start assigning work.” This supersedes
the off-by-default and first-time arming passages in `SPEC.md` and `USER_FLOWS.md`; those files
remain a historical record.

Missing supervisor settings now mean enabled. New persisted rows default to enabled, while
every stored boolean is preserved: `0` remains an intentional stop and `1` remains enabled.
Only an explicit enable/disable request changes that decision. Runner creation, reconnect,
routing, page loads, and unrelated settings writes never resume a stopped account.

The first-run checklist has six milestones: issue, CLI, runner, routing, automation ready,
and first run. A saved stop makes Resume automation the immediate single action. Description
and repository context are optional guidance outside progress. Routing remains explicit and
all existing eligibility, blocker, capacity, availability, and cancellation rules remain.

Verification covers missing-row API, dispatch, delivery and sweep behavior; partial writes
and saved-false preservation; title-only/no-repository local first runs; stop/resume; and
managed settings persistence without requiring paid provider work.
