# Shared projects, decisions, and personal permission

This page describes the Tines/669 branch contract. Existing projects remain
in legacy mode until an owner explicitly sends the first invitation. The
branch is under review and is not a production release.

## Browser permission

In consent mode, an accepted member or the project owner can choose their own
issue and future-schedule permission in an authenticated browser session. API keys, including run keys,
cannot pass `allow_my_agents`, `personal_consent`, or equivalent consent
fields. A Bearer header alongside a browser cookie does not gain consent
authority. A key-authenticated create or transition that omits those fields
leaves the owner's stored choice untouched. The browser's New issue control
starts on for a nonterminal issue and explains that enabling agents lets them
use the owner's runner and account resources. No runner is needed to save the
choice. A done issue stores no choice.

An issue an agent files in a shared project — a follow-up, a subtask, or a
linked child — starts with the owner's agents off. It is a proposal: nothing
runs it until a person allows it in the browser. Issues agents file in a
project that was never shared keep the default, on.

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

The owner's permission defaults on (decision recorded in
`specs/projects/SHARING_OWNER_DEFAULT_2026-09-24.md`): an owner with no choice
at the issue's current epoch is admitted, as in a project that was never
shared, and only an explicit off keeps the owner's agents away. Rosters and CLI
output show that as "on (owner default)". Members stay opt-in.

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

The branch includes invitations, safe member reads, attributed comments and
awaiting-human decisions, and personal browser controls. Only the owner's
approved agents can be admitted. Member permission is saved for later work;
it never grants member execution here. Key consent is a separate downstream
issue.

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
permission; future issues are **on by default** for the owner. The schedule's own browser
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
choices; for the owner they become an explicit off, and instances created
while it is off inherit that off. A person's explicit choice on an individual
issue remains independent. Turning the future choice on again affects only
issues created afterward. Deleting a schedule or changing its templates,
workflow, effective start, recurrence, timezone, or gate clears members' future
permission and inherited on grants; the owner keeps their future choice, and an
inherited owner off survives. Renaming and pause/resume preserve it. A workflow
initial-state change resets schedules that follow that initial state; a
starting state's category change also resets affected schedules. Issue
completion, transfer, and workflow replacement still clear that issue's
permission without changing the schedule's future choice. Accepted members
can save their own future choice in the browser. Member execution remains
unavailable in this release.

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
Member issue and schedule administration and member execution remain
unavailable. A member can leave their own project.

The isolated test identity scheme is Alice as owner, Bob as recipient and
Carol as wrong-account viewer. `project-membership.spec.ts` uses the local
Worker/D1 stack and an E2E-only invitation email sink; the sink route does not
return links in production builds. The first two-account run passed the phone
join/read/revocation journey. Focused SQLite tests cover acknowledgement,
verified email, resend, cancel, delivery failure, idempotency and reinvitation.
The completed slice 3 read and privacy evidence is recorded in
`docs/project-membership-read-boundary.md`.

## Attributed member decisions

An accepted member can comment and edit or delete their own human comments
and own-run comments. The owner can moderate project comments. A run key
can repair only a comment originally made with that exact run key. The
original author and run remain immutable; edits record the named editor.
Comment writes recheck current membership inside the commit batch, so removal
or leave wins over a stale prepared write. Members may take only an exact
transition from a current `awaiting_human` state, with the current state,
workflow, decision, and personal-choice witnesses. An archived project or
unmet artifact gate still blocks the transition. A stale witness records no
decision or permission change.

The member issue page shows owner-first, stable member permission rows and a
single minimal run status. It offers separate comment, decision, and own
issue-permission controls. The shared project page exposes own future-schedule
permission; the Agents page lists safe shared issues awaiting the member's
decision, without loading the owner's fleet. The issue control explains that
member execution is unavailable and leaves execution guidance undisclosed.
All session choices retain the person's draft after a failed save. Keys can
read safe receipts but cannot set on or off, including through create or
transition input. A member's on choice is stored with its membership revision
and never becomes an admission predicate in this release.

Canonical project and issue events are stored once in the project owner's
stream with the actual member as actor. The member feed reads those same IDs
through current membership and an explicit type/payload allowlist. Historical
events do not grant access after removal or transfer. Owner private fields,
run logs, key metadata, and arbitrary context payloads stay out of shared
projections.
