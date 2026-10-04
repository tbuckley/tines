# Tines — Organizations

> Status: **proposed**, 2026-10-04. Nothing here has shipped. Reviewed
> 2026-10-04; the decisions from that review are listed at the end. It changes
> the packs MVP (`specs/packs/MVP_SPEC.md`) as listed under *Changes to the
> packs MVP*, and it assumes member execution (Tines/670) has landed first.

## In one paragraph

An **organization** holds projects, and it is the only unit of sharing. Every
user has a **personal organization**, created with their account, that holds
the projects they have today. A user can create a **shared organization** and
invite close collaborators; everyone in it can work in every project in it.
Context, workflows, labels and packs belong to an organization (shared by
all its projects) or to one project in it. Nothing a person sets up for
themselves reaches a shared organization's projects, and nothing a
collaborator changes there reaches that person's personal projects. Runs stay
personal: each run uses its contributor's runner, account and secrets.

## Why

- **Packs across projects.** A project-level pack has to be installed, and
  later replaced, in every project that wants it. An organization-level pack
  applies to all of the organization's projects at once.
- **Consistency between collaborators.** Today a shared project runs on its
  owner's context: the owner's global prompts and skills apply, and their
  edits made for personal projects leak into shared work. In an
  organization, every contributor's runs read the same context.
- **No project owner.** With member execution in place, the project owner's
  remaining roles (default consent, administration, the event stream, the
  context source) all have a better home in the organization.

## Goals

- Put sharing, administration and context in the organization; keep compute,
  accounting and credentials with each contributor.
- Let packs, workflows, context and labels live at organization level or
  project level.
- Migrate every existing user and project without changing what any run in a
  personal project reads.
- Move a project between organizations with a full preview of what changes.

## Non-goals (deferred)

- **The `member` role.** Organizations will have managers and members, with
  members unable to change organization-level packs, context and
  administration. The MVP has only the owner and managers; everyone invited
  joins as a manager.
- **Organization-supplied secrets.** Every secret is supplied by the
  contributor whose run uses it (see *Secrets*).
- **Partial access inside an organization.** Everyone in an organization can
  see every project in it. Collaborators are close collaborators.
- **Identical runs on different machines.** Contributors' runners may still
  differ: harness configuration in the contributor's home directory (for
  example `~/.claude/CLAUDE.md`, personal skills, Codex config), installed
  tools and local credentials all reach a run. Tines makes what *it* delivers
  consistent. A runner option that starts the harness with a clean home
  directory may come later.
- **Organization-level billing or runners.** Usage, cost and runner fleets
  stay per user.

## Concepts

| Term | Meaning |
| --- | --- |
| **Organization** | Holds projects, people, and organization-level context, workflows, labels and packs. Either **personal** or **shared**. |
| **Personal organization** | Created with each account; the user is its owner and only person, and it cannot be shared or deleted. Replaces today's user-level scope. |
| **Shared organization** | Created by a user, who becomes its owner. Others join by invitation. |
| **Owner** | Exactly one per organization. A manager who can also rename, delete and transfer the organization. |
| **Manager** | Everyone else in a shared organization, in the MVP. |
| **Contributor** | The user whose runner executes a run. The run's usage, cost and secrets are theirs. |
| **Organization level** | Belonging to the organization and applying to every project in it: context, workflows, labels, packs, input values. |
| **Project level** | Belonging to one project. |

## Roles

| Action | owner | manager |
| --- | --- | --- |
| Read every project, issue, schedule, workflow and context item | yes | yes |
| Create, edit and transition issues; comment; take decisions | yes | yes |
| Opt their own runners in to an issue or schedule | yes | yes |
| Create, archive and delete projects | yes | yes |
| Edit context, workflows, labels and packs at either level; set input values; set `run_scope` | yes | yes |
| Invite and remove managers | yes | yes |
| Move a project in or out (with manager or owner in the other organization too) | yes | yes |
| Rename or delete the organization; transfer ownership | yes | no |
| Leave the organization | no | yes |

The `member` role, when it comes, takes the first three rows and project-level
editing; which of the rest it gets is decided then. Nothing here needs a data
change to add it: `organization_member.role` already exists.

The membership read boundary (`docs/project-membership-read-boundary.md`) no
longer separates people inside an organization: everyone in it reads
everything in it except other users' personal records (their runners,
routing, usage, run logs, secrets, API keys and personal choices).

### Ownership, leaving and deletion

- **The owner cannot leave.** They transfer ownership to a manager first (the
  previous owner becomes a manager), or delete the organization. A personal
  organization cannot be left, transferred or deleted.
- **Removing a manager** ends their personal choices, schedule choices and run
  keys in the organization's projects, as removal from a project does today.
  Their usage history and their own secrets stay theirs.
- **Deleting a shared organization** deletes every project in it, with their
  issues, schedules, artifacts and context, and every organization-level
  workflow, label and pack. Usage records stay with each contributor. The
  confirmation lists every project with its issue count, offers *Move a
  project out first* beside each, and is enabled only once the person has
  typed the name of every project, then the organization's name. It refuses
  while any run is `launching` or `running`, listing them; `assigned` runs are
  released.

## Runs and consent

Tines/670 gives each issue a set of personal choices: each person opts their
own runners in. Organizations keep that, with these rules:

- **Defaults.** The issue's creator's choice defaults to on (in a personal
  organization that is always its one user). Everyone else opts in. Issues
  filed by runs start with every choice off, as proposals, as today.
- **No resets from definition changes.** Editing a workflow, replacing a pack
  and moving a project never clear choices, whatever they change. The person
  making the change reviews what it means, on the screen that already shows
  it. The decision revision still advances on a state or transition change,
  but only to refuse a transition submitted from a stale screen; it no longer
  invalidates choices. (Today, `docs/shared-projects.md`, a definition change
  invalidates choices; this replaces that rule.)
- **What still clears a choice:** moving the issue to Done (unchanged), the
  person losing access to the organization, and the person turning it off.

A run reads the effective context of its issue, which is the same whoever the
contributor is, plus the contributor's own secret values. The run key is bound
to the contributor's **organization membership revision** in place of the
project membership revision (`agent_run.admitted_membership_revision`), and
fails closed on a removal or rejoin exactly as it does now.

Personal records stay per user: runners, routing rules (each still keyed by
project, state and label), supervisor settings, model rates, usage, API keys
and personal choices.

## Context

### Layers

For an issue in project P (in organization O), in state S of workflow W:

1. **organization** — O's packs' project-reach items, in O's pack order, then
   O's own items with no project (today's global items);
2. **project** — P's packs' project-reach items, in P's pack order, then P's
   own project-scoped items;
3. **workflow** — if W is in a pack, that pack's pack-reach items, then W's
   workflow items, then S's state items;
4. **state additions** — O's own items on S (state-scoped, no project), then
   P's own items on S, including the journal;
5. label, then issue — unchanged.

The later layer wins a name, as today. There is no user layer: a person's
own context reaches only the projects of their personal organization, through
that organization's layers. `specs/packs/SPEC.md` decision 8 (the user context
layer) is withdrawn.

### Secrets

Every secret has a **name** and a **hint**, set by whoever writes the context,
and a **value per contributor**, set by each contributor for themselves.

- An env item with a secret value becomes a *secret requirement*: the item
  keeps its name and hint; values live in `contributor_secret`.
- A pack's `secret` input works the same way. The pack declares it; each
  contributor supplies their own value.
- A contributor who has not supplied a value for a secret in an issue's
  effective context is not eligible to run that issue. The Issues page shows
  them the missing-secret warning, privately (as planned for Tines/670);
  other contributors are unaffected.
- No one can read another contributor's value. A value stays with its owner
  when they leave an organization, and is no longer used there.
- In a personal organization the only contributor is the user, so this is
  today's behaviour with the value moved to its own table.

There is no configuration: no secret is supplied by the organization.

## Workflows and labels

Workflows and labels belong to an organization or a project, in place of a
user.

- System workflows (`Standard` and the others, `user_id IS NULL`) stay
  system-owned and are offered in every organization.
- An organization-level workflow is offered in every project in it; a
  project-level one only in its project. Workflows in packs follow their
  pack's level.
- `run_scope` values become `issue`, `project` and `organization`.
  `workspace` is renamed everywhere: stored values, the API, the CLI, the UI
  and the docs. Because the stored value changes, it ships in two steps: a
  worker that reads both values, then a migration that rewrites stored
  `workspace` to `organization` and rebuilds the CHECK. The API accepts
  `workspace` as an alias for one release, then refuses it.
- Labels follow the same split. Label names are unique within their level.

## API keys

Today a key's policy has three domains (`specs/api-keys/SPEC.md`):
`projects` (an access level and `all` or a list of project ids), `workspace`
(shared context, workflows and labels) and `control_plane` (runners, routing,
credentials). They were defined when every project and every workflow a user
could reach was their own.

**The problem.** Without an organization dimension, joining a shared
organization silently widens every key the person already has. A key made for
a script on personal projects, with `projects.scope: all` and
`workspace: write`, could now edit every shared project and every
organization-level pack the person can manage. Removing it from the key means
the person editing the key, which they have no reason to know to do.

**Decision: an `organizations` scope.**

- The policy gains `organizations: 'all' | [organization ids]`, and its
  version becomes 2. `workspace` is renamed `organization` and now means
  organization-level context, workflows, labels and packs, within the
  scoped organizations. `control_plane` is unchanged and stays personal; it
  now also covers the contributor's own secret values.
- A key's reach is the intersection of its policy and the person's current
  memberships. Leaving or being removed from an organization takes it out of
  every key at once, with no key edit.
- `projects.scope` stays as a narrower filter. A listed project reaches only
  while it is in a scoped organization, so a project moved out drops out of
  the key; a key never follows a project into another organization.
- `organizations: 'all'` includes organizations joined later. The key form
  says so, and it is never the default: a new key defaults to the
  organization the person is in when they create it.
- Issuing a runner token keeps its rule (all projects, organization write,
  control-plane write), with `organizations: 'all'`: a runner serves every
  organization its user contributes to.
- Run keys are unaffected. Their ceiling binds them to the run's project, and
  `run_scope: organization` widens them to the run's own organization only.

**What it costs.**

- **Migration.** Existing keys get `organizations: [personal organization]`,
  which is exactly what they reach today. The two users of the one shared
  project also get the new shared organization added to keys that reach that
  project today (migration step 2), so nothing they use stops working.
- **The CLI.** A project name resolves among the projects the key reaches.
  The same name in two organizations is an ambiguity error listing both
  (already the rule for duplicate readable names), and commands gain
  `--org <name>` to choose.
- **The key form and list** show organizations as well as projects. The
  existing policy parser and intersection code (`packages/shared/src/permissions.ts`)
  gain one dimension.

The cheaper alternative, warning on invitation acceptance which keys will
now reach the organization, was rejected: it is easy to miss, and a missed
warning leaves a key wider than its owner intended.

## Suggested schedules from organization packs

An organization pack is never installed into a project, so there is no
install screen to set up its suggested schedules on. A suggestion is pack
data, and each project shows it as an offer until someone acts on it. No
schedule is created, paused or otherwise, without a person choosing it.

- **New project.** The New project flow has a **Schedules** step listing every
  suggested schedule from the organization's packs, grouped by pack, each
  with its rendered title, recurrence and workflow. Each group has *Select
  all*. A suggestion marked `suggested: on` starts checked; the rest start
  unchecked. Each row has a timezone, defaulting to the person's own, and a
  suggestion that references an input with no value cannot be checked, as on
  the MVP's install screen. Checked suggestions are created as ordinary,
  enabled project schedules, with the creator's future-issue choice on and
  everyone else opting in (see *Runs and consent*).
- **Later.** A project's Schedules page has a **Suggested** section listing
  the suggestions it has not set up, each with *Set up* and *Dismiss*. The
  list is computed: the organization packs' suggestions, minus those the
  project has created a schedule from (the MVP records which suggestion a
  schedule came from), minus those it dismissed. A suggestion added by a pack
  install or Replace appears there, and the project shows how many are
  waiting.
- **Existing projects.** An organization pack's Packs page offers **Set up in
  projects…** when it is installed or gains suggestions: choose projects, then
  the same checklist, applied to each.
- **No organization-wide schedules.** A schedule belongs to one project.
  A schedule that fired in every project would start recurring runs, on
  whoever has opted in, each time a project is created.

Project packs keep the MVP's flow: suggestions are offered on their install
screen, and also appear in the project's Suggested section.

## Moving a project between organizations

Moving is how a personal project becomes shared, and how a shared project is
taken back. It changes who can see the project, its effective context and the
workflows its issues can use, so it is one operation with a preview and a
confirmation bound to it, reusing the issue-transfer pipeline
(`apps/web/src/lib/server/api/issue-transfer.ts`: preview → witness →
commit → receipt).

### Who

A person who is a manager or owner in both organizations, from a browser
session. API and run keys cannot move a project.

### Blockers

The preview lists these, each with a remedy, and the move cannot be
confirmed while any remains:

- a run is `launching` or `running` on one of the project's issues (place
  holds or wait; `assigned` runs are released by the move without a strike);
- the destination already has a project with the same name;
- a workflow mapping (below) is incomplete.

### The preview

1. **People.** Who gains access to the project and who loses it. Losing
   access ends that person's personal choices, schedule choices and run keys
   in the project, exactly as removal does.
2. **Workflows.** Every workflow in use (by an issue, a schedule, the default
   workflow, or a `workflow` input value), with what happens to it:
   - **project-level** — moves with the project, unchanged;
   - **system** — stays;
   - **organization-level in the source** — the mover chooses, per workflow:
     - **Bring a copy** (default): the workflow, with its state-scoped
       organization context and inheritance chain, is copied into the project
       as a project-level workflow. Issues and schedules move to the copy
       state by state; nothing needs mapping.
     - **Map** to a workflow available in the destination, through the
       state-mapping screen, pre-filled by state key, then by state name. A
       workflow from a pack whose pack id exists at the destination's
       organization level pre-selects Map to it.
3. **Packs.** The project's own packs move with it. Source organization packs
   stop applying; destination organization packs start. A source
   organization pack's workflows are handled in step 2 (Bring a copy
   detaches the copy as a project-level authored pack, with `derived_from`
   set).
4. **Inputs.** The project's own input values move. Values that pointed at a
   source organization workflow follow the step-2 choice (to the copy, or to
   the mapped workflow). Inputs left without a value show *needs setup*.
5. **Labels.** Project-level labels move. Organization labels used by the
   project's issues, schedules or context are copied to the destination
   project's level, unless the destination organization already has a label
   with the same name, which is used instead.
6. **Effective context.** For each workflow state in use, the effective
   context before and after, as the issue-transfer preview shows it today
   (`IssueTransferContextChange`): items lost, gained, and overridden
   differently. Secret requirements gained are listed with how many people in
   the destination have supplied a value.
7. **Links.** Issue links to projects in the source organization are kept,
   and follow the existing rule for targets the reader cannot see (omitted;
   a hidden blocker is a generic blocked flag).

### The commit

One transaction:

- `project.organization_id` changes; issues keep their ids, numbers and
  addresses.
- Workflow and label copies are created and issues, schedules and context
  re-pointed; mapped issues move state.
- Personal choices are kept for people who have access on both sides, and
  cleared for people who lose it (see *Runs and consent*).
- Every run key bound to the project is revoked; runs launched after the move
  get keys bound to the destination.
- The project's events, comments, artifacts and run history stay with it and
  are readable by the destination's people. The source organization keeps a
  `project.moved_out` event naming the destination.

### Share this project

From a project in a personal organization, **Share** creates a shared
organization and moves the project into it in one flow. Because the new
organization is empty, the preview offers one more choice: **bring the
context that applies to this project**. The personal organization's own
items that reach it (today's global items, and organization-level state items
on the workflows it uses) are copied to the new organization's level.
Without it, Bring a copy still carries each workflow's state context, but the
organization-wide items are left behind. Invitations are then sent from the
new organization.

## Migration

Done in this order. Each migration stays readable by the worker deployed
before it (`CLAUDE.md`, migrations).

### 1. Organizations for everyone

- Create `organization` and `organization_member`; create one personal
  organization per user, with the user as `owner`. Signup creates it from
  then on.
- Add a nullable `organization_id` to `project`, `workflow` (except system
  workflows), `context_item` and `label`, and backfill each to its user's
  personal organization. Schedules, issues and artifacts are already keyed by
  project and need nothing.
- `context_item` keeps `user_id` as its author. Items with no project, state,
  issue or label (today's global items) become organization-level items in
  the personal organization. Nothing else about scope changes.
- Secret env values move from `context_item.env_value_enc` to
  `contributor_secret`, with the item's user as contributor.
- API keys get `organizations: [personal organization]`.

For every project except the shared one, effective context is unchanged:
same items, same order, same winners. The migration is checked by computing
the effective context of every active issue before and after and comparing
them.

### 2. The one shared project

Production has one shared project, with two users. It moves into a new
shared organization through **Share this project**, with **bring the context
that applies to this project** on:

- the organization is named after the project; the project's owner becomes
  its owner and the other user a manager;
- every owner workflow the project uses is copied in (Bring a copy), with
  its inheritance chain and state context;
- the owner's global items, and the owner's state-scoped items on those
  workflows, are copied to the new organization's level;
- labels used by its issues, schedules and context are copied;
- the owner's secret requirements that reach the project are copied as
  requirements; the owner's own values are copied to their
  `contributor_secret` rows, and the other user is shown the missing-secret
  warning until they supply theirs;
- the other user's own context is not copied: it never applied to the
  project;
- both users' API keys that reach the project today get the new organization
  added.

Each user's personal projects and context are untouched. This runs once, by
an operator, with a receipt under `docs/receipts/` listing the before and
after effective context of each active issue.

### 3. Retire project-level sharing

- `project_member` and `project_invitation` become read-only, then are
  dropped in a later migration. Invitations are sent from an organization
  (`organization_invitation`, same token, expiry and verified-email rules as
  today).
- The consent-mode conversion is no longer a per-project switch: shared
  organizations are always in consent mode.
- Run keys are bound to the organization membership revision.
- `run_scope` `workspace` is rewritten to `organization` (see *Workflows and
  labels*).

### 4. The authorization audit

Every check of `project.user_id = ?` or `workflow.user_id = ?` becomes a
membership check on the project's organization, including dispatch
(`loadEligibleIssues`), effective-context loading and every member
projection. The owner/member/key/run/outsider matrix and the native D1
claim, delivery, removal and cancellation races from the shared-projects
work are run again against organizations.

## Changes to the packs MVP

- **Where a pack lives.** `pack` has an organization or a project as owner.
  Packs pages exist at both levels; the stitch order is the one under
  *Layers*.
- **Organization packs apply at once.** Installing, replacing or removing an
  organization pack takes effect in every project. Replace's state mapping
  covers issues in all of them, and the replace screen says how many issues
  in how many projects move. The MVP goal "move each project to a newer
  version when you choose to" is withdrawn for organization packs.
- **Replace never clears personal choices** (see *Runs and consent*).
- **Input values at two levels.** An organization pack's inputs take
  organization-level values, which a project can override. A project pack's
  inputs take project values only. An organization-level `workflow` value can
  bind only to an organization-level workflow; a project override may bind to
  a project one. A `workflow` input renders with the run's own project, so a
  handoff files into the same project.
- **Secret inputs** are supplied by each contributor (see *Secrets*). The
  MVP's per-project secret value is removed.
- **Install sources.** *From my projects* becomes *From my organizations*,
  listing packs at both levels in organizations the person belongs to.
- **Who can do what.** The MVP's table applies at both levels, to owners and
  managers. `run_scope: workspace` in the MVP's formats becomes
  `organization`.
- **Suggested schedules** gain an optional `suggested: on`, which pre-checks
  the suggestion wherever it is offered. Suggestions not yet set up are listed
  on each project's Schedules page (see *Suggested schedules from organization
  packs*). Replace still never rewrites a schedule created from a suggestion.
- **Pack ids** are unique per owner. A project may install a pack id that its
  organization also has; the project's copy applies after it (it is a later
  layer), and the Packs page marks both.

## Data model sketch

Illustrative; the migration plan comes with implementation.

- `organization` — `id`, `name`, `kind` (`personal` | `shared`),
  `created_by`, `created_at`, `updated_at`.
- `organization_member` — `organization_id`, `user_id`, `role` (`owner` |
  `manager`, later `member`), `revision`, `joined_at`, `revoked_at`,
  `updated_at`. One active `owner` per organization, enforced by a partial
  unique index.
- `organization_invitation` — as `project_invitation`, keyed by organization.
- `project`, `workflow`, `context_item`, `label` gain `organization_id`;
  `workflow`, `context_item` and `label` gain `project_id` where they can be
  project-level.
- `contributor_secret` — `user_id`, `context_item_id` or (`pack_id`,
  `input_name`), `value_enc`, `updated_at`.
- `pack` gains `organization_id`; `project_id` becomes nullable (exactly one
  set). `pack_input_value` gains a nullable `project_id` for overrides.
- `project_schedule_dismissal` — `project_id`, `pack_schedule_id`,
  `dismissed_by`, `dismissed_at`.
- `api_key.permissions` version 2: `organizations`, `projects`,
  `organization`, `control_plane`.

## Order of work

1. Tines/670, member execution.
2. Organizations: migration steps 1, 3 and 4, organization invitations,
   ownership transfer and deletion, contributor secrets, API key scope,
   project moves and Share this project.
3. Migration step 2 for the shared project.
4. The packs MVP, with the changes above.

## Decided in review

Decided 2026-10-04.

1. **Run permission defaults.** The issue's creator is opted in by default,
   not a project owner; everyone else opts in.
2. **Roles.** Organizations have an owner, managers and, later, members.
   The MVP has only the owner and managers.
3. **No resets from definition changes.** Workflow edits, pack replaces and
   project moves never clear personal choices. The person making the change
   reviews what it means.
4. **`workspace` is renamed `organization`** everywhere, stored values
   included, to drop the legacy term.
5. **The user context layer is withdrawn.**
6. **Labels are copied** when a project moves between organizations.
7. **API keys gain an `organizations` scope**, so joining an organization
   never widens an existing key.
8. **The owner cannot leave** a shared organization; they transfer ownership
   or delete it.
9. **A shared organization with projects can be deleted**, behind a
   confirmation that requires typing every project's name.
10. **Organization pack schedules are offered, never created unasked.** A new
    project chooses them in a Schedules step; any project can set them up
    later from its Suggested list. There are no paused placeholder schedules
    and no organization-wide schedules.
