# Shared-project implementation verification · 2026-09-23

**Branch:** `tines/669-project-membership`. **Status:** parent assembly in progress;
the proposed [669 → 670/712 contract](../shared-project-execution-contract.md)
is unreviewed until the parent lands and review completes. All fixtures ran in
an isolated local Worker/D1 stack. No production project, run, account, or
email was used.

## Fixtures and screens

Alice E2E is the project owner; Bob E2E is the accepted member; Carol E2E is
the wrong-account/outsider fixture. Invitation links came only from the
E2E-only email sink. Test project names and issue IDs were generated per run.

Screenshots from the isolated two-account journey:

- [Member issue, 390×844](shared-projects-2026-09-23/member-phone.png)
  and [390×560](shared-projects-2026-09-23/member-small-phone.png)
- [Member issue, 1440×900](shared-projects-2026-09-23/member-desktop.png)
  and [future schedule control](shared-projects-2026-09-23/member-schedule.png)
- [Owner issue, 390×844](shared-projects-2026-09-23/owner-phone.png)
  and [1440×900](shared-projects-2026-09-23/owner-desktop.png)

## Checks completed

| Command | Result |
| --- | --- |
| `pnpm check` | Passed migration, package, shared, CLI, and Svelte/type checks. |
| `pnpm format:check` | Passed after formatting the slice files. |
| `pnpm test` | Passed: 333 shared, 719 CLI, 2,278 web unit tests. |
| `CI=1 E2E_PORT=8895 pnpm exec playwright test e2e/member-decisions.spec.ts e2e/project-membership.spec.ts` from `apps/web` | 6 passed: invitation/join/read/CLI/privacy and initial member decision journey. |
| `CI=1 E2E_PORT=8897 pnpm exec playwright test e2e/member-decisions.spec.ts` | 2 passed: browser and CLI decision path, plus native D1 removal between choice preparation and commit. |
| `CI=1 E2E_PORT=8898 pnpm exec playwright test e2e/native-collaboration.spec.ts e2e/native-schedules.spec.ts` | 22 passed: conversion, owner consent, source ordering, hold, claim/delivery, cancellation slot, and schedule rollback. |
| `CI=1 E2E_PORT=19002 pnpm exec playwright test e2e/member-decisions.spec.ts` | 2 passed after the final two-account phone/desktop screenshot and decision control changes. |
| `CI=1 E2E_PORT=19033 pnpm exec playwright test e2e/member-decisions.spec.ts --grep 'native D1 member writes'` | 1 passed: 14 comment/decision winner-order cases against removal, archive, transfer and workflow revision. |
| `CI=1 E2E_SKIP_BUILD=1 E2E_PORT=19034 pnpm exec playwright test e2e/member-decisions.spec.ts e2e/native-collaboration.spec.ts e2e/native-schedules.spec.ts e2e/project-membership.spec.ts` | 30 passed together, including two-account browser/API/CLI, native D1 and admission regression. |
| `CI=1 E2E_PORT=19035 pnpm exec playwright test e2e/member-decisions.spec.ts --grep 'native D1 owner hold'` | 1 passed after rebuilding with the hold-order probe. |

The local CLI decision submitted the exact current witness once and created
no personal choice. Bob's key was refused on both explicit on and off before
a choice row existed. Bob's browser choice was stored, but the member receipt
reported execution unavailable and no agent run was created. Bob's comment
and transition events appeared once in Alice's stream with Bob as actor.
The member issue HTML and API journey did not contain the seeded private
context, routing, GitHub, or foreign-link canaries.

The new native removal probe revoked Bob after the service read its choice
witness but before the D1 batch. The write returned 409 and created neither
choice nor event; a follow-up member issue read returned 404. The prior native
collaboration suite showed owner hold releasing assigned work without a strike,
claim losing to off before delivery without a key, and admitted cancellation
retaining its live slot until acknowledgement. These are observed outcomes of
the isolated runs, not assertions about untested winner orders.

## Actor and native write matrix

`member-decisions.test.ts` checks owner identity and member session/key reads,
named-key comment attribution, browser-only consent refusal for that key,
and content-free 404 for a pending invitee, outsider, and member run key.
`project-membership.spec.ts` checks pending/wrong-account and outsider privacy,
accepted member issue/schedule API and CLI projections, and safe pagination.
`member-decisions.spec.ts` checks Bob's issue and future-schedule browser controls,
the safe Agents awaiting-decision surface, Alice's phone/desktop issue view,
and no member run after Bob saves on. `schedule-consent.test.ts` checks member
schedule roster, key policy intersection, outsider refusal, and inherited
instance provenance. Existing comment tests check run-self-only moderation.

The native D1 member-write probe changes the authoritative predicate after
the service read and before the guarded batch. The losing comment/decision
receipts had no new comment, event, state, or choice side effect. A winning
write stayed attributed when the competing action happened afterward.

| Predicate changed | Comment loses | Exact decision loses | Write wins first |
| --- | --- | --- | --- |
| Member removal | 404 | 409 | One attributed write, then revocation |
| Project archive | 404 | 409 | One attributed write, then archive |
| Issue transfer | 404 | 409 | One attributed write, then transfer |
| Workflow decision revision | Still allowed | 409 | Decision commits, then revision changes |

Owner hold is separate from decision authority: the native probe confirms a
member decision can commit with a hold winning before the batch, and a hold
after a member decision does not turn the member's saved choice into a run.

## Parent assembly

The shared branch merged main with Tines/648's scoped-key authorization and
project switcher. Shared project reads now intersect membership with project
key scope, while member write routes require their specific key permission.
Invitations and acceptance remain session only; keys cannot grant consent.
Regression tests cover the scoped read and write paths. The issue page resolves
canonical project IDs directly, avoiding an extra project-access query on
ordinary navigation. `pnpm --filter @tines/web perf:nav` passed all six cases,
including the zero-duplicate issue-detail statement assertion. The combined
`pnpm test` pass covered 345 shared, 719 CLI, and 2,252 web tests after the
main merge. Isolated browser/API journeys passed 9/9, and isolated native D1
collaboration interleavings passed 16/16.

The complete `pnpm check` and `pnpm format:check` gates passed after the
integration. Browser regressions exposed name-based URL expectations after
the issue loader canonicalized project IDs; the affected error-page, issue
creation, duplicate, and transfer specs were updated and rerun (24/24 for the
first three; 24/24 for dialog
and transfer after waiting for the entrance animation). CI runs all three
Playwright shards on the final branch. Review still needs to decide whether
the proposed execution contract is ready to become the reviewed 670/712
dependency; this receipt does not make that claim.
