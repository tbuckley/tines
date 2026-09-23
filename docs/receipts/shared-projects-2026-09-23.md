# Shared-project implementation verification · 2026-09-23

**Branch:** `tines/669-project-membership`. **Status:** slice 4 checkpoint;
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
| `pnpm test` | Passed: 333 shared, 719 CLI, 2,277 web unit tests. |
| `CI=1 E2E_PORT=8895 pnpm exec playwright test e2e/member-decisions.spec.ts e2e/project-membership.spec.ts` from `apps/web` | 6 passed: invitation/join/read/CLI/privacy and initial member decision journey. |
| `CI=1 E2E_PORT=8897 pnpm exec playwright test e2e/member-decisions.spec.ts` | 2 passed: browser and CLI decision path, plus native D1 removal between choice preparation and commit. |
| `CI=1 E2E_PORT=8898 pnpm exec playwright test e2e/native-collaboration.spec.ts e2e/native-schedules.spec.ts` | 22 passed: conversion, owner consent, source ordering, hold, claim/delivery, cancellation slot, and schedule rollback. |
| `CI=1 E2E_PORT=19002 pnpm exec playwright test e2e/member-decisions.spec.ts` | 2 passed after the final two-account phone/desktop screenshot and decision control changes. |

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

## Remaining verification for the slice

The focused runs above do not complete the design's full adversarial matrix.
Deterministic native D1 pre-commit tests are still needed for member comment
and exact decision versus removal, archive, transfer, and workflow reset;
the opposing winner orders for those cases; and member/key/run/pending/outsider
receipt comparisons across issue, Agents, and schedule surfaces. The complete
E2E/CI and navigation performance gates remain for the parent assembly pass.
