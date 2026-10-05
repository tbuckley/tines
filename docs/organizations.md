# Organizations

An **organization** holds projects and is the unit of sharing. The design record is
[specs/packs/ORGANIZATIONS_SPEC.md](../specs/packs/ORGANIZATIONS_SPEC.md); this guide says what the
code does today, including where it stops short of the spec.

## Personal and shared

Every user has a **personal organization**, `org_<user id>`, created by migration `0053` (and
lazily for accounts made later). It holds everything they had before organizations, and nothing
about how their personal projects run changes.

A **shared organization** is created from **Organizations → New organization** (or by **Share** on
a personal project). Its creator is its **owner**; people who accept an invitation join as
**managers**. Everyone in it can work in every project in it. There is no `member` role yet.

| | owner | manager |
| --- | --- | --- |
| Work in every project (issues, comments, decisions, project context, packs) | yes | yes |
| Create projects in it, move projects in or out (as a manager or owner of both sides) | yes | yes |
| Invite and remove people | yes | yes |
| Organization-level context, workflows and labels | yes | read through its projects |
| Rename, transfer ownership, delete | yes | no |
| Leave | no (transfer first) | yes |

## How it is stored

A shared organization's projects, workflows, labels and context are owned (`user_id`) by its
owner, exactly as a shared project's were; `organization_id` keeps them apart from the owner's
personal rows. A NULL `organization_id` means the owner's personal organization, so rows written by
code that predates organizations stay correct (`COALESCE(organization_id, 'org_' || user_id)`).

Everyone else in a shared organization is written through as a **member of each of its projects**
(`project_member`, `org-membership.ts`): joining adds them to every project, a new project or a
project moved in adds everyone, and leaving or removal revokes them everywhere. The project-level
sharing rules — consent mode, personal permission, the member read boundary, run-key binding and
fencing (`docs/shared-projects.md`, `docs/project-membership-read-boundary.md`) — therefore apply
unchanged. Project-level invitations are refused for a project in a shared organization: people are
managed on the organization. A project still in a personal organization keeps the per-project
sharing it had.

**Runs.** Member execution (Tines/670) has not landed, so in a shared organization only the
owner's runners run issues, as only a shared project's owner's did. Transferring ownership hands
that to the new owner.

## What applies where

- **Context.** An item anchored to a project or issue applies there. A project-less item (global,
  state-only or label-only) applies only in its own organization's projects
  (`contextOrgPredicate`): an owner's personal global prompts never reach a shared organization, and
  its organization-level items never reach their personal projects. Create an organization-level
  item with `organization_id` (owner only).
- **Workflows** are offered only in their organization's projects (system workflows everywhere);
  using one elsewhere is refused (`workflow_not_in_organization`). Create one with
  `organization_id` (owner only).
- **Labels** resolve, and are created on the fly, in the issue's organization. Names are unique
  within an organization.
- **Project names** are unique within an organization.

## Moving a project, and Share this project

**Move** (project page; `GET/POST /api/v1/projects/:id/move`) is one reviewed operation, bound to
the preview's digest and allowed only from a browser session, for a person who is an owner or
manager of both organizations. The preview lists who gains and loses access, each workflow in use
and what happens to it, labels, the organization-level context the project stops reading, and
blockers (a run launching or running, a name already taken). On commit:

- organization-level workflows in use come along as **copies** (with their state context), and
  issues, schedules, the default workflow, pack inputs, routing rules and project additions are
  re-pointed to the copies; pack workflows and system workflows move or stay as they are;
- labels in use map to the destination's same-named label, or are copied;
- the project's own context moves with it; if the destination has a different owner, its rows
  change owner;
- people who lose access lose their membership (their choices end and their runs are asked to
  stop); people who gain it become members; assigned runs are released and run keys bound to the
  project revoked; a `project.moved` event is recorded.

**Share** (personal projects; `POST /api/v1/projects/:id/share`) creates a shared organization
named after the project and moves the project into it, optionally **bringing the context that
applies to it** (the personal organization's global items are copied). The sharer's API keys that
reached the project gain the new organization.

## API keys

A key's policy may name `organizations: 'all' | [ids]` (version 2). A version-1 key (every key made
before organizations) reaches its owner's personal organization — and projects shared with them
the old per-project way — and nothing else, so joining an organization never widens a key. A
project in an organization the key does not name is invisible to it (404). Project-less context,
workflows and labels are filtered the same way.

## Not done yet

- Organization-level **packs** (installing a pack once for every project in an organization) —
  packs are project-level.
- **Map** a moved project's workflow onto a destination workflow (only Bring a copy).
- The `member` role, and managers editing organization-level context, workflows and labels.
- Removing today's run-permission resets (spec decision 3).
- Retiring `project_member`/`project_invitation` and rewriting stored `workspace` run scopes to
  `organization` (the API already accepts `organization` as an alias).
- Deleting an organization whose projects still have issues (move them out first).
