# Shared project personal permission and admission

This page records the owner execution boundary being added for Tines/669. The
membership and invitation flows are delivered by later slices. Existing
projects remain in legacy mode until a sharing flow marks them shared; no
production sharing entry point is exposed by this slice.

## Owner permission

In consent mode, only the project owner's authenticated browser session can
create or change a personal issue permission. API keys, including run keys,
cannot pass `allow_my_agents`, `personal_consent`, or equivalent consent
fields. A Bearer header alongside a browser cookie does not gain consent
authority. A key-authenticated create or transition that omits those fields
leaves the owner's stored choice untouched. The browser's New issue control
starts on for a nonterminal issue and explains that enabling agents lets them
use the owner's runner and account resources. No runner is needed to save the
choice. A done issue stores no choice.

Choices are revisioned per issue and carry the issue's consent epoch. A
separate issue permission write includes the expected choice revision, issue
epoch, and decision revision. The server rejects stale requests without
changing the choice. A choice is valid only for its recorded epoch. Moving an
issue into Done clears the choice and advances the epoch; leaving Done does
not restore it. Forced state changes, workflow replacement, and cross-project
transfer use the same structural reset. Ordinary edits, archive, and hold
preserve permission. A workflow definition change advances its decision
revision; changing a state to Done also clears choices on issues in that
state. An archived nonterminal issue may still save a personal choice, but
that never unarchives it or admits work.

Transitions in consent mode use the exact transition ID and compare the state,
workflow decision revision, issue decision revision, consent revision, and
consent epoch in the write transaction. A lost comparison returns a conflict
and requires a fresh browser decision. The CLI fetches the current witness and
submits an exact transition once; it has no consent flag and never retries a
different decision after a conflict.

## Admission, holds, and cancellation

The dispatch claim and delivery boundary both check the owner's current issue
choice. Delivery also compares the claim's sharing revision, choice revision,
and issue epoch. A change after claim therefore cannot deliver the stale
assignment. Turning permission off and placing an owner hold release only
`assigned` runs; the release leaves issue attempt counts unchanged. A run that
already crossed into `launching` or `running` keeps its slot.

The owner hold has its own expected revision. Holding prevents later admission
without changing permission; releasing the hold also leaves permission
unchanged. The CLI commands are `tines issues hold <ref>` and
`tines issues release <ref>`.

Cancellation of an assigned run settles it without a strike. Cancellation of
admitted work is recorded as a request and revokes its API key, while the run
remains active until terminal acknowledgement or existing timeout/offline
reconciliation. Updated local daemons acknowledge after process and workspace
cleanup. Older daemons still receive the existing kill signal and use timeout
reconciliation. Run cancellation is available as
`tines issues cancel-run <ref> <run-id>` and remains issue-bounded.

The browser Agent activity card shows the current personal choice, hold,
eligibility, and admitted run receipt. Its controls save against current
revisions and reload after a stale response. Turning permission off can
release assigned work, but an already admitted run may finish. Cancellation
does not change permission, so new work may become eligible after that run
settles unless permission is off or the issue is held.

## Availability

This is an implementation contract, not a user launch point. The branch has
the owner execution boundary and future schedule permission. No production
sharing entry point exists yet. Invitations, member reads and decisions are
later slices; key consent is a separate downstream issue.

## Isolated verification (2026-09-23)

Consent mode was enabled only by the `native-collaboration.spec.ts` fixture in
the disposable local D1 database. Its Alice test account is an isolated fixture;
the tests did not change a production project. The native checks observed:

- Browser Agent activity saved an off choice and an owner hold.
- Explicit key on and off were both refused before issue creation; an omitted
  key choice created no grant, while session creation saved the owner's choice.
- Two writes using one choice revision produced one success and one conflict;
  moving the issue to Done cleared the choice and advanced its epoch.
- An owner hold canceled an assigned run without an attempt strike. A cancel
  request for an admitted run left its active slot until acknowledgement.
- A native claim lost to off before delivery without minting a run key; a
  delivered claim recorded admission evidence and held its slot through off
  until a matching cleanup acknowledgement.

The runner protocol tests also confirm that a legacy daemon keeps that slot
until reconciliation and an updated daemon settles it only with a matching
token after local cleanup.

The verification commands were `pnpm check`, `pnpm format:check`,
`pnpm --filter web test`, `pnpm --filter tines test`, and
`CI=1 E2E_PORT=8897 pnpm test:e2e native-collaboration.spec.ts native-schedules.spec.ts`.
The combined native run passed 10 tests; the added claim/delivery case passed
in a separate focused run. The web and CLI suites passed 2,251 and 719 tests
respectively. These results verify the earlier owner slice; the schedule
verification has its own receipt below.

## Future schedule instances

In consent-mode projects, the browser's New issue form offers two separate
choices when Repeat is selected. The initial issue follows ordinary creator
permission; future issues are **off by default**. The schedule's own browser
control saves an on/off choice with an expected revision and semantic
permission epoch. A key may read the safe schedule summary, but explicit
permission input from an API key or run key is refused before creating or
editing any issue or schedule. The CLI has no schedule consent command or
flag. Imported schedules do not infer permission from their creator.

Cron and Run now read the currently saved schedule choice inside the guarded
creation batch. Their event actor never becomes the consenting person. The
new issue records the schedule, grant revision, and permission epoch on its
inherited choice. It also keeps a separate origin snapshot of the schedule's
template, workflow, resolved start, recurrence, timezone, gate, and execution
revision. That snapshot survives a later edit or deletion and does not grant
permission by itself. Personal runner routing, pins, environment and
credentials are never copied from the schedule.

Turning future permission off revokes unlaunched, still-inherited instance
choices. A person's explicit choice on an individual issue remains
independent. Turning the future choice on again affects only issues created
afterward. Deleting a schedule or changing its templates, workflow, effective
start, recurrence, timezone, or gate clears future permission and inherited
unlaunched permission. Renaming and pause/resume preserve it. A workflow
initial-state change resets schedules that follow that initial state; a
starting state's category change also resets affected schedules. Issue
completion, transfer, and workflow replacement still clear that issue's
permission without changing the schedule's future choice. The owner is the
only person who can write a schedule choice in the current branch. Invitation
can now activate membership, but member choice writes remain disabled until
the next slice; member execution remains unavailable in this release.

## Isolated schedule verification (2026-09-23)

All fixtures used the seeded Alice account, browser session and API key on a
fresh disposable Worker/D1 stack. Shared mode was set only on test projects
inside that stack. `native-collaboration.spec.ts` passed 11 tests, including
phone controls, cron and Run now inheritance, a real browser off request
committed after Run now prepared but before its batch, the reverse order,
and deletion/meaningful-change winning before creation. In each losing
creation case, the issue/event/cursor receipt had no partial new issue.
An additional focused native case verifies that off cancels only an assigned
inherited run without a strike, while an admitted run keeps its slot.
`native-schedules.spec.ts` passed its six existing native gate, cursor,
skip and rollback cases against the new creation batch. The source tests
also cover explicit instance override, re-enable without retroactive grants,
rename/pause/resume, semantic edits, workflow-follow initial state,
completion/reopen, source deletion, current membership and key-read
intersection. The full web and CLI unit suites and repository checks were
run after the changes; their exact passing totals are recorded in the slice
comment on Tines/714.

Commands: `CI=1 E2E_PORT=18715 pnpm test:e2e native-collaboration.spec.ts
native-schedules.spec.ts` (16 passed), then `CI=1 E2E_PORT=18716 pnpm test:e2e
native-collaboration.spec.ts -g 'off committed after preparation'` (1 passed),
then `CI=1 E2E_PORT=18717 pnpm test:e2e native-collaboration.spec.ts` (11
passed), `CI=1 E2E_PORT=18718 pnpm test:e2e native-collaboration.spec.ts -g
'phone browser keeps'` (1 passed) and `CI=1 E2E_PORT=18719 pnpm test:e2e
native-collaboration.spec.ts -g 'source off releases'` (1 passed). The first
native run preceded the real-session race refinement; the later runs prove
the final ordering and assigned release. No production fixtures were created.

## Joining and reading a project (slice 3 branch contract)

An owner invites an email from People or `tines projects invite`. The first
invitation requires explicit sharing acknowledgement and the current sharing
revision. Its guarded batch permanently sets `shared_at`, advances the sharing
revision, clears any stored choices and releases assigned work without a strike.
Admitted work may finish. Existing issues and schedules require a new personal
choice before future owner admission. A failed batch sends no invitation.

Links last seven days. Only a SHA-256 hash is stored. Resend rotates the token
and generation; cancel invalidates it. Delivery occurs after commit through the
Email binding. A failed send keeps a visible failed-delivery invitation for
explicit resend. Acceptance requires a browser session whose current database
user has the verified invited email. A consumed link is idempotent for the
same active membership revision; removal invalidates it. Removing or leaving
increments a tombstone revision, clears issue and schedule choices, revokes
project run keys and requests cancellation of admitted member work. Sharing
mode remains on even after the last member leaves.

The People page lists active names and membership revisions. Pending invitees
and outsiders cannot read project content. Member project and issue pages load
only explicit shared projections before any owner context, runner, routing,
usage or workflow-library loader starts. Shared reads include project and issue
identity, safe workflow/state descriptors, comments, filtered history,
artifact versions/downloads and schedule summaries. Member HTML artifacts
remain downloads; the site-link minting route keeps its owner-only check.
Private context, account and run detail APIs retain their owner checks.
Member issue/schedule mutation and execution are disabled until their assigned
later slices. A member can leave their own project.

The isolated test identity scheme is Alice as owner, Bob as recipient and
Carol as wrong-account viewer. `project-membership.spec.ts` uses the local
Worker/D1 stack and an E2E-only invitation email sink; the sink route does not
return links in production builds. The first two-account run passed the phone
join/read/revocation journey. Focused SQLite tests cover acknowledgement,
verified email, resend, cancel, delivery failure, idempotency and reinvitation.
Full native race and cross-surface privacy coverage remain to be completed
before this slice can close; see Tines/715's handoff for the exact list.
