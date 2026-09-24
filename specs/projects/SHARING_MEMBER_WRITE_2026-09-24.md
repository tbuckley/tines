# Decision: members work on everything in a shared project (2026-09-24)

Recorded for Tines/728. This amends `SHARING_2026-09-23.md` ("membership does
not allow general issue creation/editing, label/dependency management, human
artifact uploads or administration"), which is left as written.

## Problem

Tines/669 shipped members as decision-makers. They could read, comment and
take a transition out of an awaiting-human state, and nothing else. Tom's
first collaborator could see the project's issues but could not file one.

## Decision

Tom: "They should be able to do anything on an issue or the project except
add or remove users."

A current member of a shared project may, from the browser, the API and the
CLI:

- create issues (attachments, links, labels and a recurrence included), edit
  them, force a state or change the workflow, and take any current transition;
- add and remove labels, blocks and duplicate links within the project;
- upload artifacts and versions, and mint artifact site links;
- hold and release issues, cancel an issue's run and resume a parked issue;
- moderate every comment on the project;
- create, edit, pause, delete and Run now its schedules;
- rename the project, edit its description and default workflow;
- create, read and edit context items scoped to the project or its issues.

Everything is attributed to the member. Only the owner invites or removes
people, and each person still sets only their own agent permission.

## Owner-only, by the proposals on Tines/728

Tom did not answer the six open questions on Tines/728, so its proposals
stand:

1. **Owner compute.** A member-created issue or schedule stores the owner's
   permission as an explicit `off`, so the owner-default-on rule
   (`SHARING_OWNER_DEFAULT_2026-09-24.md`) does not spend the owner's agents on
   a member's work. The creating member's own permission defaults on, as for
   any creator, and takes effect only when member execution ships.
2. **Env values** are write-only for members, secret or not.
3. **Launch prompts, effective context, run logs and spend** stay the owner's.
   Members see run status and outcome.
4. **The workflow and label libraries** are the owner's account. Members pick
   existing workflows and may add a new label to an issue, but do not edit the
   library.
5. **Runners, routing and runner pins** stay the owner's.
6. **Archiving, unarchiving and deleting the project**
   stay the owner's.

## How

A member's project-scoped request runs as a delegated actor
(`actorForProject` in `apps/web/src/lib/server/api/project-access.ts`): the
owner's `userId`, so the owner's existing services resolve the shared project,
plus a `member` field naming who acted. Events, artifact versions and personal
permission rows use the member. Links, transfers and context writes are fenced
to the shared project, and every gated write re-checks the membership revision
(`assertWritable`). Members see the owner's issue, project and issues pages
with the owner-only panels left out; the member-only pages are gone.
