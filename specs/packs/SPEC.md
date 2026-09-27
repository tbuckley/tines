# Tines — Packs: shared workflows and context, and context layers

> Status: **proposed**, 2026-09-27. Design record from a working session with
> Tom; nothing here has shipped. Where it conflicts with earlier specs it is
> the newer decision, and those specs stay as written:
>
> - `specs/context/SPEC.md` — context items are user-owned and scoped by
>   nullable dimensions; the empty scope is global. This spec replaces that
>   ownership with user and project layers, and moves workflows and the
>   context they carry into packs.
> - `specs/context/SPEC.md`, state inheritance (Tines/238) — being
>   deprecated; packs do not support it (decision 12).
> - `specs/library/SPEC.md`, `specs/library/PUBLICATIONS.md` — installs are
>   independent copies with no update path. This spec adds links that update.
> - `specs/projects/SHARING_MEMBER_WRITE_2026-09-24.md`, point 4 — "the
>   workflow and label libraries are the owner's account". Workflows become
>   project-owned.

## Problem

Workflows and context belong to a user. A project points at the user's
workflow row, so an edit to a workflow applies to every project that uses it
at once. That was fine for one person; with shared projects it is not. If
Tom shares a project and a collaborator could edit its workflow, that edit
would land in all of Tom's other projects. Today the conflict is avoided by
forbidding members from editing workflows at all.

At the same time Tom *does* sometimes want an edit in one project to reach
his other projects, and wants to install workflows other people have
published and keep them up to date as their authors improve them.

Context has a related blur: "context for me, everywhere" and "context for
this project" are both rows in one table, told apart only by which scope
columns are null.

## Goals

- A collaborator's edit in a shared project never changes any other project
  unless someone in that other project chooses to take it.
- Reuse workflows and context across your own projects and keep the copies
  in sync — without publishing anything.
- Install a published pack and receive its author's later versions, with a
  diff to review before applying.
- One unit of sharing, the **pack**, for workflows and context alike.
- Clearly separate **user** and **project** context.
- Every replacement and conflict between context items follows a stated rule
  and is visible to the people it affects.

## Non-goals

- **Merging.** Linked content is read-only; there is no overlay, no
  three-way merge, and no agent-assisted rebase in this version.
- **State inheritance** inside packs (decision 12).
- **Sharing with specific people.** Cloud visibility is private or public.
- **Schedules inside packs.** Schedules stay project-side (see Future).
- **Fine-grained member permissions** for applying, reverting or detaching.

## How we got here

Recorded so the next reader does not re-walk the same path.

1. **Figma components** were the starting analogy: a library workflow, an
   instance per project, overrides kept across updates, "push changes to
   main component" for the owner.
2. A first design followed it closely: a *home project* holding the source,
   a single *publisher* who cut numbered *releases*, *instances* with
   *overlays* of local edits, a *favorite* action to make a workflow
   reusable, and a push-to-source action. It worked but had ten concepts.
3. It was replaced by an **upstream model** — closer to git remotes than to
   Figma: every workflow is a full copy in a project, optionally **linked** to
   a source it can pull from. Releases between projects, publishers,
   favorites and push-to-source all disappeared. Numbered versions exist only
   in the cloud.
4. Overlays were dropped in favor of **read-only links**: anything a project
   wants to add lives beside the linked content in project context, which
   updates never touch; changing the linked content means detaching. This
   removes merging entirely.
5. Workflows and context bundles were linked separately at first, with
   parallel rules. They were unified: the **pack** is the only thing that is
   linked, and it may hold workflows, context, or both.

Figma still decides one rule: in review mode, whoever can read the source
can apply its update (decision 5).

## Concepts

| Term | Meaning |
| --- | --- |
| **Pack** | A named bundle of zero or more **workflows** plus **context items** (prompts, skills, repos, env). Belongs to exactly one project. Either **standalone** (editable, and can be a source) or **linked** (a read-only copy of a source). Every workflow and every shareable context item is in a pack from the moment it is created (decision 1). |
| **Project-local content** | Context that only makes sense in one project and so is never in a pack: journals, issue-scoped items, and additions attached to a linked pack's workflows or states. |
| **Source** | What a linked pack pulls from: a standalone or linked pack in **another project**, or a **cloud** listing. |
| **Link** | The record that a project's pack follows a source: its mode, the snapshot it last applied, and its history. |
| **Detach** | Remove the link. The pack becomes standalone and editable in this project, keeping its current content, under a new identity. Irreversible. |
| **Cloud** | The hosted catalog of published packs. The only place with numbered versions. Built-in workflows ship as packs published by Tines. |
| **My Workflows** | An ordinary project each user gets, created by the migration, holding the originals of their existing workflows and context as standalone packs. Nothing about it is special beyond its creation. |

## Decisions

### 1. Everything lives in a project, and everything shareable is a pack

`workflow.user_id` is replaced by ownership by a project, through a pack. A
pack belongs to a project. There is no user-level library; "my packs" means
"the packs in projects I can read", and My Workflows is simply the project
the migration puts them in.

**Packs are automatic.** Nobody has to create a pack before they can share:

- Creating a **workflow** creates a standalone pack holding it. Context added
  to that workflow's states, or to the whole workflow, goes into the same pack
  (state or pack-workflows reach, decision 9).
- Creating a **project-wide context item** (a prompt, skill, repo or env item
  for the whole project, optionally narrowed by label) creates a standalone
  pack holding just that item.
- Everything else is **project-local content**: journals, issue-scoped items,
  and items a project attaches to the workflows or states of a *linked* pack,
  which cannot be edited.

A pack of one is shown as the thing it holds — *Code change* (workflow),
*conventions* (prompt) — with no pack chrome, and takes its name from it, so
single workflows and prompts can be added to another project without anyone
thinking about packs.

**Grouping.** Users, or their agents, organize related packs into one pack to
share them together: *merge* moves the contents of several standalone packs in
one project into a single pack; *split* moves items out into packs of their
own. Both are ordinary edits of standalone packs, so projects following them
see the change as an update (decision 14). A standalone pack is live in its
own project: editing it there changes that project immediately.

### 2. Adding a pack to a project

Project → Packs → **Add**:

- **Create new** — an empty standalone pack in this project.
- **From my projects** — any pack in a project you can read. Creates a linked
  copy whose source is that pack.
- **From the cloud** — browse the catalog, including built-ins. Creates a
  linked copy whose source is the cloud listing.

**The source is always the immediate thing you copied from.** Copying a pack
from a project whose copy itself came from the cloud links to *that project*,
not to the cloud. So A → B → C means C follows B; when A changes, C sees it
only after B has taken it. Links are made only when copying, so cycles
cannot form.

**A pack is added to a project at most once.** Every pack has an **origin**
identity, minted when it is created and carried by every linked copy and
cloud version of it. A project may hold one pack per origin, however it was
reached: adding "Engineering" from the cloud to a project that already
follows your copy of Engineering is refused with *already added (via …)*.
Detaching gives the pack a new origin, since it is now its own pack.
Variants are handled with labels — routing rules and pack narrowing
(decision 9) both select by label — not by adding a pack twice.

### 3. Linked content is read-only

Everything in a linked pack comes from its source and cannot be edited in the
copy:

| Travels with the pack (read-only when linked) | Stays with the project (survives every update) |
| --- | --- |
| Workflows: states with name, category and **stable key**; transitions with names and artifact requirements | Runner routing and pins; model tier and effort |
| **`run_scope`** of each state (decision 7) | Label narrowing of the pack's project-wide items (decision 9) |
| Context items and their **reach** (decision 9) | Values for secret env declarations; overrides of non-secret values |
| Declared variables (names, types, defaults) | Variable **values** |
| | Project-local content attached to the pack's workflows or states, including journals |
| | Schedules, and labels that point at the pack's states |
| | The pack's precedence among the project's packs (decision 10) |

To change anything in the left column, **detach**.

### 4. Updates

**Where updates come from.** A link to a project offers that source's
*current* content — there are no releases between projects, so an in-progress
edit in the source appears as an available update. A link to the cloud offers
the next published version.

**Modes, per link:**

- **Review** (default): the project shows *Update available*; opening it shows
  the diff from the applied snapshot (workflows, states, transitions,
  `run_scope`, every prompt and skill file, repos, env, variables, reach), the
  state mapping, and every replacement and conflict the update creates or
  changes (decision 10). Apply or skip.
- **Auto-update**: applies without asking, unless it must pause (below).
  Only the **project owner** can turn auto-update on, and it runs as the
  project owner.

Third-party updates are new prompt text that will run on your agents. The
diff is what defends against prompt injection, which is why review is the
default and auto-update is an explicit choice.

**History and revert.** Every applied update stores a snapshot on the link.
Revert applies an earlier snapshot through the same path as an update
(mapping, reviews, conflicts). The source never needs to keep versions for
this.

**Applying in place.** An update rewrites the linked copy's rows, matching
workflows and states by **stable key**, so their IDs survive. Issues, project
content, schedules, routing and labels that reference a state keep
referencing it across renames. A key is minted when the workflow or state is
created and copied unchanged into every linked copy and cloud version.

**State mapping (required).** If an update removes a state — or a whole
workflow — that holds issues in this project, each such state must be mapped
to a state that exists after the update; the update does not apply until
every occupied removed state is mapped. Cloud versions declare a mapping,
which pre-fills the screen. A link to a project cannot declare one, so the
person applying supplies it. Project-local content on a removed state moves
with the same mapping. Runs already in progress finish on the context they
launched with (the launch snapshot, `0040_run_key_stage_snapshot`).

**Runner behavior after an update.** A transition the workflow no longer
allows is refused, and the refusal lists the transitions now available from
the issue's current state with their artifact requirements, so the agent can
choose again.

**Auto-update pauses** into review mode — the whole update waits, never half
of it — when:

- a removed state holds issues (mapping needed);
- the update widens any state's `run_scope` (decision 7);
- the update broadens any item's reach (decision 9);
- the update creates a conflict that needs a choice (decision 10);
- the update declares a new secret env value the project has not supplied;
- the project owner cannot read the source (decision 5).

### 5. Who can pull

- **Review mode** follows Figma: anyone in the project who can read the
  source sees *Update available* and the diff and can apply it. Others see the
  pack as it is, with no update prompt. Once applied, the update is in the
  project for everyone.
- **Auto-update runs as the project owner** — consistent with shared
  projects, where project-scoped actions already act under the owner's
  account (`actorForProject`). If the owner cannot read the source, the link
  pauses and shows *source not accessible*.
- For v1 any project member may add, apply, revert and detach, subject to the
  owner-only approvals in decision 7. A permission to restrict that is future
  work.

### 6. Losing the source

- **Access lost**: the link stays. People who can't read the source see
  *source not accessible to you*; anyone who can may still pull.
- **Source deleted** (or a cloud listing withdrawn or removed): the link
  becomes detached and the pack standalone, with a notice on the project.
  Deleting a pack that other projects follow warns with the number of
  followers you can see.

### 7. `run_scope` belongs to the workflow, and is reviewed

Some states cannot work without `project` or `workspace` access, so
`run_scope` travels with the pack. Authority arriving through a link is
reviewed instead:

- **Adding** a pack lists every state whose `run_scope` is `project` or
  `workspace`. **Updating** lists the states whose scope widens.
- Approving a list that includes a widening, or any `project`/`workspace`
  state on add, requires the **project owner in a browser session**. No API
  key or run key can approve it (the same boundary `0047` set for editing
  `run_scope`). Members may add or update when nothing widens.
- `workspace` states are labelled **high risk**. A `workspace` run may edit
  anything directly, including other projects' packs and the originals in My
  Workflows; the review says plainly that such edits can reach every project
  that auto-updates from what the run touches.

### 8. Context layers

| Layer | Owned by | Applies | Visible to |
| --- | --- | --- | --- |
| **User** | a user | runs by *that user's* agents, in every project | that user |
| **Project** | a project: its packs plus its project-local content | that project's issues, by reach and scope | project members |

A workflow's instructions are no longer a separate owner: they are context
items in the pack that holds the workflow, with a reach
naming the workflow or one of its states.

**User context is about who is running, not what is being worked on.** It
holds preferences ("short updates, open questions last"), identity (git
author, GitHub handle), personal credentials (env items), personal
guardrails ("never push to main"), and facts about the user's runner
environment. It follows the agent: in a shared project, the owner's runs get
the owner's user context; when member execution ships, a member's runs get
the member's. It is never applied to someone else's agent. Members of a
shared project see a content-free notice that the owner's personal context
also applies to the owner's runs.

The test for where an item belongs: *would a collaborator's agent working in
this project need it too?* If yes, it belongs in a pack or in project-local
content.

**Journals are always per project.** A journal (the prompt named `journal`,
`specs/context/AGENT_EDITING.md`) is project-local content, scoped to a
state.
Packs cannot carry one, publishing refuses a pack that contains one, and a
journal's entries never leave the project.

### 9. Reach: where a pack's items apply

Every context item in a pack has one **reach**:

| Reach | Applies to | Allowed in |
| --- | --- | --- |
| **State** | issues in one state of one of the pack's workflows | packs with workflows |
| **Pack workflows** | issues in any of the pack's workflows | packs with workflows |
| **Project** | every issue in the project | any pack |

- A pack **without workflows** is project context: all its items have
  project reach.
- A pack **with workflows** defaults new items to *pack workflows* reach. It
  may also carry project-reach items, but adding such a pack is **flagged**:
  *this pack also adds context to every issue in the project, not only its
  workflows*, listing those items.
- An update that **broadens** reach — a new project-reach item, or an item
  moved from state to pack-workflows or from pack-workflows to project reach
  — is flagged in the update review and pauses auto-update.
- The project can **narrow** a pack's project-reach items to particular
  labels. Narrowing is project-side and survives updates.

**Env variables** follow the same reach:

- A **secret** env item travels only as a *declaration* (name, description,
  hint). The project supplies the value when adding the pack. Until it is
  supplied the pack is added but flagged *needs setup*, and a run whose
  context needs the missing value is not admitted.
- A **non-secret** env item travels with its value and applies only within
  its reach. The project may override the value; the override is project-side
  and survives updates.

### 10. Stitching, replacement and conflicts

**Stitch order** is user → project → workflow → issue, which is today's
dimension-weight order (`specs/context/SPEC.md`) with user context where the
global scope sits now:

1. user context;
2. project-reach items, packs in precedence order;
3. *pack workflows* items for the issue's workflow;
4. *state* items for the issue's state;
5. project-local content on that state, including the journal — so a
   project's additions for a stage sit directly after the pack's
   instructions for it;
6. label, then issue layers, unchanged.

Launch prompts for existing items keep their order through the migration.

**Prompts always append**, in that order. They never replace or conflict.
Changing a pack's prompt means detaching.

**Skills, repos and env items are named, and one name yields one item.** When
several matching items share a kind and name, exactly one applies, chosen by
these rules in order:

| # | Situation | Winner | Choice needed? | How people see it |
| --- | --- | --- | --- | --- |
| 1 | Issue-scoped project-local content vs anything | the issue item | no | issue context view |
| 2 | Other project-local content vs a pack item | project-local content | no | the pack item shows *replaced in this project by …*; an update that changes it is flagged |
| 3 | Two items in different packs, one with narrower reach (state or pack workflows) than the other (project) | the narrower one, within its reach; the broader one elsewhere | no | the broader item shows *replaced in workflow … by pack …* |
| 4 | Two items in different packs with the same reach level | the pack with higher **precedence** | **yes** when adding or updating a *linked* pack creates the clash: the person applying chooses which pack wins. **No** when editing a *standalone* pack in this project creates it: that is a deliberate local replacement, and the edited pack moves above the other | both items show the outcome; the pack page lists all its clashes |
| 5 | Two items in the same pack | — | cannot happen: names are unique per kind within a pack, checked when authoring and when validating a published version | — |
| 6 | Any pack or project-local item vs user context | the project's item | no | effective context lists the user item as overridden |

Pack precedence is a project-side order over the project's packs, set by
those choices and editable on the Packs page. Two packs may each contain a
workflow with the same name; that is not a conflict — an issue is bound to
exactly one workflow — and pickers show *Workflow · Pack*.

**Awareness surfaces**, so nobody is surprised by a replacement:

- the **add** review lists every replacement and conflict the pack would
  introduce, alongside `run_scope` and reach;
- the **update** review lists those the update creates, changes or removes;
- the **pack page** shows a standing *Replacements and conflicts* panel;
- the effective-context view and API keep listing losing items under
  `overridden`, with the rule that decided it.

### 11. Publishing to the cloud

- Any **standalone** pack can be published. A linked pack must be detached
  first, so you only ever publish content you control.
- Publishing leaves the pack standalone and marks it *published as X*. You
  keep editing it and choose when to publish the next version, which gets
  the next number, release notes, and a declared state mapping for any
  removed states.
- Projects that copy it from your project link to your project, not the
  cloud.
- Visibility is **private** (only you can add it) or **public** (listed).
  This builds on the existing immutable snapshots, moderation, and
  publication authority (`specs/library/PUBLICATIONS.md`): a version is a
  snapshot with a listing and a number.
- **Built-ins** are packs published by Tines. Projects pull their updates
  like any other; nobody else can publish to them.

### 12. No state inheritance in packs

State inheritance (`workflow_state.inherits_from_state_id`, Tines/238) is
being deprecated. Packs neither carry nor accept it: a pack's workflow states
have no base, and a state's context is only what its pack and the project
attach to it. Content shared across several workflows in a pack uses *pack
workflows* reach instead. The migration flattens existing inheritance
(decision 13); the journal is keyed to `project ∧ state` directly.

### 13. Migration

1. Create a **My Workflows** project for each user who owns a workflow or
   global context.
2. **Flatten inheritance.** Copy each base state's context into each
   inheriting state as that state's own context, then clear the pointers.
   A base's journal is copied to each inheriting state's journal in the same
   project.
3. **One standalone pack per workflow** in My Workflows, named after the
   workflow, holding it and its state-only context (state reach). Stable
   keys are assigned to the workflow and its states.
4. For every project whose issues, default workflow or schedules use one of
   those workflows, **add** a linked copy of its pack with **auto-update**,
   repointing issues, schedules, routing and project-local content to the copy's
   states. This preserves today's "edit once, applies everywhere". Other
   workflows are no longer offered in that project until their pack is
   added. A project can detach its copy to make it the root for that
   workflow; other projects keep following My Workflows.
5. System workflows (`user_id` NULL) become built-in packs; each project
   using one gets a link.
6. Other context items move by scope:

   | Scope today | Becomes |
   | --- | --- |
   | project, alone or with label | a standalone pack of one in that project (project reach, label narrowing kept) |
   | project ∧ state (not a journal) | added to the workflow's pack if the project's copy is detached; otherwise project-local content on that state |
   | issue (with anything) | project-local content on that issue |
   | empty (global) | a pack of one in My Workflows (project reach), added to every project with auto-update |
   | label only | a pack of one in My Workflows (project reach), added to every project with auto-update and narrowed to that label |

   A `journal` is never moved into a pack: it becomes project-local content,
   and one without a project in its scope is copied into each project that
   uses its state. Nothing lands in user context automatically, so every
   launch prompt keeps its content and order; the user, or their agent, moves
   the truly personal items across and groups the rest into larger packs
   deliberately.

### 14. Grouping packs that others follow

Merging and splitting change what a pack contains, so they reach every
project following it:

- **Merge.** Merging packs X and Y into Y removes X from its project and
  records X's origin on Y. Each project following X sees an update: *X moved
  into Y*. Applying it replaces the link to X with a link to Y — the review
  shows everything Y adds beyond X as new content, so auto-update pauses for
  it and each project decides whether it wants Y's additional workflows and
  context — or, if the project already follows Y, simply removes the X link.
  The alternative offered on the same screen is to detach X and keep it as it
  is.
- **Split.** Moving items out of Y into a new pack Z gives Z a new origin.
  Projects following Y see those items removed in the next update, with an
  offer to add Z alongside.
- The once-per-project rule (decision 2) counts absorbed origins: a project
  that follows Y cannot also add X.

## Data model sketch

Illustrative, not binding; a migration plan comes with implementation.

- `pack` — `id`, `project_id`, `origin_id`, `name`, `description`,
  `published_listing_id`; `UNIQUE (project_id, origin_id)`.
- `pack_absorbed_origin` — origins merged into a pack, for the
  once-per-project check and for redirecting followers.
- `workflow` gains `project_id` and nullable `pack_id` (replacing `user_id`)
  and `key`; `workflow_state.key`.
- `context_item` gains an owner — exactly one of `user_id`, `project_id`
  (project-local content, with the existing state / label / issue scope
  columns),
  or `pack_id` — and, for pack items, a `reach` (`state` | `workflows` |
  `project`) with the state or workflow it names.
- `pack_link` — `pack_id`, `source_kind` (`project` | `cloud`), `source_id`,
  `mode` (`review` | `auto`), `applied_snapshot_id`, `paused_reason`.
- `pack_snapshot` — immutable applied content per link, for diff and revert.
- `project_pack_settings` — precedence, label narrowing, env values and
  overrides, variable values.
- Cloud versions extend `workflow_publication` with a listing identity, a
  version number, release notes and a state mapping.

## Future

- **Schedules in packs**: a publisher may ship an optional schedule with a
  recommended frequency; the project decides whether to enable it.
- **Permissions** for who may add, apply, revert and detach.
- **Specific-people visibility** for cloud listings.
- **Re-link a detached pack** to a newer source, with an agent porting the
  local edits — the original "agent re-applies my modifications" idea.
- **Move all links to a new root** after detaching.
