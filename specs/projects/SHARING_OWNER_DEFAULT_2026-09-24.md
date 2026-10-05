# Decision: the owner's agent permission defaults on (2026-09-24)

Recorded during review of Tines/669 (PR #289). This amends
`SHARING_2026-09-23.md`, which is left as written.

## Problem

`SHARING_2026-09-23.md` made every personal permission opt-in: once a project
is shared, only an issue whose owner row reads `on` at the current epoch may be
admitted. The first invitation therefore stopped all of the owner's existing
work, because those issues had no row. Issues created afterwards through an API
key (the CLI, agents filing follow-ups, imports) also never gained a row,
because keys cannot supply consent. Schedule instances ran only if the owner
had separately switched each schedule's future permission on.

## Decision

Tom chose "owner default on":

- The project owner's missing or stale (earlier epoch) choice counts as on for
  the owner's own agents, exactly as before the project was shared.
- An explicit `off` at the issue's current epoch always wins. It is set on the
  issue, or inherited from a schedule whose future permission the owner turned
  off.
- Members stay fully opt-in, and their agents are still never admitted in this
  release.
- Rosters and CLI output show the owner's unset as "on (owner default)".
- The owner sees the agent-permission disclosure once, at first share.

## Alternatives rejected

- **Backfill `on` rows at share time.** It covers existing issues only; every
  later key-created issue and schedule instance would still start unset and not
  run.
- **Backfill by issue creator.** It misses issues created by the CLI, by agents,
  and by schedules, which have no browser creator to take consent from.

## Consequences

- Admission (`ownerIssueConsentPredicate`) tests for the absence of a current
  owner `off` row instead of the presence of an `on` row. The inherited-grant
  revalidation against the live schedule choice is gone: an inherited `on` is
  the same as the default, and revoking a schedule's future permission now
  rewrites the owner's inherited rows to `off`.
- Schedule instances inherit the owner's `off` as an `off` row, so an instance
  created while future permission is off stays off after the schedule is
  deleted or redefined. Schedule definition changes keep the owner's future
  choice under the new epoch; members still reset to off.
- Lifecycle resets that clear a choice to `unset` (Done, forced moves, workflow
  replacement, transfer) return the owner to the default, on.
- The owner turning an issue on releases assigned work, so a claim taken under
  the old choice revision is re-dispatched rather than stuck behind the
  delivery guard.
- A member's transition signals a dispatch pass for the owner, so the owner's
  agents pick up the new state promptly.

## Amendment 2026-09-26 — run-filed issues (Tines/751)

An issue created by a run key in a shared project — by an owner run or a
member run, directly or as a link-created child — is written with an owner
`off` row at the current epoch, in the same batch as the issue. It is an
unapproved proposal until a person turns it on in the browser. Parent consent
never propagates; key consent fields still fail with
`consent_browser_required`. Never-shared projects keep the default, on.
