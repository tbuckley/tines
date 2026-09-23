# Shared project owner permission and admission

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

This is an implementation contract, not a user launch point. This slice adds
the owner execution boundary and its browser and CLI controls. No production
sharing entry point exists in this branch. Invitations, member reads and
decisions, schedule inheritance, and key consent belong to later work.

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

The runner protocol tests also confirm that a legacy daemon keeps that slot
until reconciliation and an updated daemon settles it only with a matching
token after local cleanup.

The verification commands were `pnpm check`, `pnpm format:check`,
`pnpm --filter web test`, `pnpm --filter tines test`, and
`CI=1 E2E_PORT=8897 pnpm test:e2e native-collaboration.spec.ts native-schedules.spec.ts`.
The focused native run passed 10 tests. The web and CLI suites passed 2,251 and
719 tests respectively. These results verify the owner slice; member and
schedule consent paths are delivered by later slices.
