# Period detail and direct lifetime — 2026-09-13

This decision extends [period usage](./PERIOD_USAGE_2026-09-11.md) and [Spend navigation](./SPEND_NAVIGATION_2026-09-11.md). Those records remain the contract for period arithmetic, dimensions, boundaries and parent controls.

## Decision

- Period reports mint HMAC-signed, owner-bound scopes after resolving `[from,to)`, timezone and filters. Replaying a scope keeps those inputs while regenerating the report from retained records.
- Aggregate detail is a secondary issues/runs view, not a new primary breakdown. Issue summaries and finalized runs default to exact stored cost descending, with unknown dollars last in either direction. Time and raw IDs deterministically break ties.
- Evidence pages report totals for the whole selected population. Member-narrowed runs also retain the parent total. Pending runs are separate and use an as-of projection that never selects later usage, outcome, end, provider or error facts.
- Issue lifetime is explicit `mode=issue`, through a single resolved now cutoff. It includes every retained direct attempt across stages and retries and excludes descendants and dependencies. The same evidence renderer enumerates its runs independently of the operational newest-20 list.
- A zero priced cost is measured zero. No finalized priced evidence is Unknown. Zero attempts is “No agent runs”; pending-only remains separate and is not fully priced.

Scopes and evidence cursors use distinct signing domains and the existing server secrets. They grant no authority: every query and hydration remains account-fenced. Retention or metadata can change between replays, so a scope is a frozen selection rather than a persisted snapshot.

Completion-event cohorts, terminal history and all-issue means are deliberately excluded from this mode and owned by Tines/498. Current issue state is never substituted for historical completion membership.
