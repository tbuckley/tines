# Shared project owner permission and admission

This page records the owner execution boundary being added for Tines/669. The
membership and invitation flows are delivered by later slices. Existing
projects remain in legacy mode until a sharing flow marks them shared; no
production sharing entry point is exposed by this slice.

## Owner permission

In consent mode, only the project owner's authenticated browser session can
create or change a personal issue permission. API keys, including run keys,
cannot pass `allow_my_agents`, `personal_consent`, or equivalent consent
fields. A key-authenticated create or transition that omits those fields leaves
the owner's stored choice untouched.

Choices are revisioned per issue and carry the issue's consent epoch. A
separate issue permission write includes the expected choice revision, issue
epoch, and decision revision. The server rejects stale requests without
changing the choice. A choice is valid only for its recorded epoch. Moving an
issue into Done clears the choice and advances the epoch; leaving Done does
not restore it.

Transitions in consent mode use the exact transition ID and compare the state,
workflow decision revision, issue decision revision, consent revision, and
consent epoch in the write transaction. A lost comparison returns a conflict
and requires a fresh browser decision. Project transfer, workflow replacement,
and workflow-definition invalidation still need their remaining slice wiring.

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

## Availability

This is an implementation contract, not a user launch point. The owner
permission controls on New issue, transitions, and Agent activity, the full
issue lifecycle invalidation matrix, and isolated native-D1 race evidence are
still required before Tines/669 can be assembled or exposed.
