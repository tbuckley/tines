# Tines — Linked workflows, context packs, and context layers

> Status: **proposed**, 2026-09-27. Design record from a working session with
> Tom; nothing here has shipped. Where it conflicts with earlier specs it is
> the newer decision, and those specs stay as written:
>
> - `specs/context/SPEC.md` — context items are user-owned and scoped by
>   nullable dimensions; the empty scope is global. This spec replaces that
>   ownership with three layers and moves workflow-carried context onto the
>   workflow.
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
- Reuse a workflow across your own projects and keep the copies in sync —
  without publishing anything.
- Install a published workflow and receive its author's later versions, with
  a diff to review before applying.
- Reusable bundles of context (**packs**) that are not tied to a workflow,
  with the same install-and-update behavior.
- Three clearly separate context layers: **user**, **workflow**, **project**.

## Non-goals

- **Merging.** Linked content is read-only; there is no overlay, no
  three-way merge, and no agent-assisted rebase in this version.
- **Sharing with specific people.** Cloud visibility is private or public.
- **Schedules inside workflows.** Schedules stay project-side (see Future).
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
3. It was replaced by the **upstream model** below — closer to git remotes
   than to Figma: every workflow is a full copy in a project, optionally
   **linked** to a source it can pull from. Releases between projects,
   publishers, favorites and push-to-source all disappeared. Numbered
   versions exist only in the cloud.
4. Overlays were then dropped in favor of **read-only links**: anything a
   project wants to add lives beside the workflow in project context, which
   updates never touch; changing the workflow itself means detaching. This
   removes merging entirely.

Figma still decides one rule: in review mode, whoever can read the source
can apply its update (decision 5).

## Concepts

| Term | Meaning |
| --- | --- |
| **Workflow** | Belongs to exactly one project. Either **standalone** (editable) or **linked** (read-only). |
| **Pack** | A named bundle of context items (prompts, skills, repos, env) with no states. Belongs to exactly one project. Standalone or linked, like a workflow. |
| **Linkable** | A workflow or a pack. Everything below about links applies to both unless it says otherwise. |
| **Source** | What a linked linkable pulls from: a linkable in **another project**, or a **cloud** listing. |
| **Link** | The record that a project's linkable follows a source: its mode, the snapshot it last applied, and its history. |
| **Detach** | Remove the link. The linkable becomes standalone and editable, keeping its current content. Irreversible; later updates are not offered. |
| **Cloud** | The hosted catalog of published linkables. The only place with numbered versions. Built-in workflows are cloud listings published by Tines. |
| **My Workflows** | An ordinary project each user gets, created by the migration, holding the originals of their existing workflows and packs. Nothing about it is special beyond its creation. |

## Decisions

### 1. Every linkable lives in a project

`workflow.user_id` is replaced by `workflow.project_id`. A pack likewise
belongs to a project. There is no user-level library; "my workflows" means
"the workflows in projects I can read", and My Workflows is simply the
project the migration puts them in.

### 2. Adding a workflow or pack to a project

Project → Workflows (or Context) → **Add**:

- **Create new** — a standalone linkable in this project.
- **From my projects** — any linkable in a project you can read. Creates a
  linked copy whose source is that project's linkable.
- **From the cloud** — browse the catalog, including built-ins. Creates a
  linked copy whose source is the cloud listing.

A project holds at most one link per source. The copy's display name is a
project-side setting, so two same-named sources can coexist.

**The source is always the immediate thing you copied from.** Copying from a
project whose workflow itself came from the cloud links to *that project*,
not to the cloud. So A → B → C means C follows B; when A changes, C sees it
only after B has taken it. Links are made only when copying, so cycles
cannot form.

### 3. Linked content is read-only

Everything that *is* the workflow comes from the source and cannot be edited
in the linked copy:

| Travels with the workflow (read-only when linked) | Stays with the project (survives every update) |
| --- | --- |
| States: name, category, **stable key**, inheritance | Display name of the copy |
| Transitions, names, artifact requirements | Runner routing and pins; model tier and effort |
| **`run_scope`** of each state (decision 7) | Variable **values** |
| Workflow context: prompts, skills, repos carried by its states | Project context scoped to its states, including journals |
| Declared variables (names, types, defaults) | Schedules, and labels that point at its states |

A pack's items all travel; the project-side settings of a pack link are its
narrowing (decision 10) and its position among the project's packs.

To change anything in the left column, **detach**.

### 4. Updates

**Where updates come from.** A link to a project offers that source's
*current* content — there are no releases between projects, so an in-progress
edit in the source appears as an available update. A link to the cloud offers
the next published version.

**Modes, per link:**

- **Review** (default): the project shows *Update available*; opening it shows
  the diff from the applied snapshot (states, transitions, `run_scope`,
  every prompt and skill file, repos, variables), the state mapping, and any
  project replacements the update touches (decision 8). Apply or skip.
- **Auto-update**: applies without asking, unless it must pause (below).

Third-party updates are new prompt text that will run on your agents. The
diff is what defends against prompt injection, which is why review is the
default and auto-update is an explicit choice.

**History and revert.** Every applied update stores a snapshot on the link.
Revert applies an earlier snapshot through the same path as an update
(mapping, scope review). The source never needs to keep versions for this.

**Applying in place.** An update rewrites the linked copy's rows, matching
states by **stable key**, so state IDs survive. Issues, project context,
schedules, routing and labels that reference a state keep referencing it
across renames. A state's key is minted when the state is created and copied
unchanged into every linked copy and cloud version.

**State mapping (required).** If an update removes a state that holds issues
in this project, each such state must be mapped to a state that exists after
the update; the update does not apply until every occupied removed state is
mapped. Cloud versions declare a mapping, which pre-fills the screen. A link
to a project cannot declare one, so the person applying supplies it. Project
context scoped to a removed state moves with the same mapping. Runs already
in progress finish on the context they launched with (the launch snapshot,
`0040_run_key_stage_snapshot`).

**Runner behavior after an update.** A transition the workflow no longer
allows is refused, and the refusal lists the transitions now available from
the issue's current state with their artifact requirements, so the agent can
choose again.

**Auto-update pauses** into review mode — the whole update waits, never half
of it — when:

- a removed state holds issues (mapping needed);
- the update widens any state's `run_scope` (decision 7);
- the project owner cannot read the source (decision 5).

### 5. Who can pull

- **Review mode** follows Figma: anyone in the project who can read the
  source sees *Update available* and the diff and can apply it. Others see the
  copy as it is, with no update prompt. Once applied, the update is in the
  project for everyone.
- **Auto-update runs as the project owner** — consistent with shared
  projects, where project-scoped actions already act under the owner's
  account (`actorForProject`). If the owner cannot read the source, the link
  pauses and shows *source not accessible*.
- For v1 any project member may apply, revert and detach. A permission to
  restrict that is future work.

### 6. Losing the source

- **Access lost**: the link stays. People who can't read the source see
  *source not accessible to you*; anyone who can may still pull.
- **Source deleted** (or a cloud listing withdrawn or removed): the link
  becomes detached and the copy standalone, with a notice on the project.
  Deleting a linkable that other projects follow warns with the number of
  followers you can see.

### 7. `run_scope` belongs to the workflow, and is reviewed

Some states cannot work without `project` or `workspace` access, so
`run_scope` travels with the workflow. Authority arriving through a link is
reviewed instead:

- **Adding** a workflow lists every state whose `run_scope` is `project` or
  `workspace`. **Updating** lists the states whose scope widens.
- Approving a list that includes a widening, or any `project`/`workspace`
  state on add, requires the **project owner in a browser session**. No API
  key or run key can approve it (the same boundary `0047` set for editing
  `run_scope`). Members may add or update when nothing widens.
- `workspace` states are labelled **high risk**. A `workspace` run may edit
  anything directly, including other projects' workflows and the originals
  in My Workflows; the review says plainly that such edits can reach every
  project that auto-updates from what the run touches.

### 8. Context layers and stitching

| Layer | Owned by | Applies | Visible to |
| --- | --- | --- | --- |
| **User** | a user | runs by *that user's* agents, in every project | that user |
| **Workflow** | a workflow | issues in that workflow's states | anyone who can read the workflow |
| **Project** | a project (its own items plus added packs) | that project's issues, optionally narrowed by state, label or issue | project members |

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
this project need it too?* If yes, it is project context or a pack.

**Stitch order:** user → project → workflow → issue, which is today's
dimension-weight order (`specs/context/SPEC.md`) with user context where the
global scope sits now and workflow context in the `state` slot:

1. user context;
2. project-wide items: added packs in the order they were added, then the
   project's own items (`project`, weight 1);
3. the workflow's own state context, bases before the state
   (`state`, weight 2);
4. project items narrowed to a state (`project ∧ state`, weight 3) — so a
   project's additions for a stage, and its journal, sit directly after the
   workflow's instructions for that stage;
5. label, then issue layers, unchanged.

Launch prompts for existing items therefore keep their order through the
migration.

**Replacement across layers.** Stitch order decides where prompts appear;
replacement by name is decided by **owner**, so that it does not depend on
how narrowly an item is scoped: issue beats project (including packs), which
beats workflow, which beats user.

- **Skills and repos** replace by name — a project item with the same kind
  and name as a workflow's item wins, even when the project item is
  project-wide. A project can therefore replace a linked workflow's or pack's
  skill or repo without detaching. Within one owner the existing rule stands
  (the later layer wins). When an update changes an item the project
  replaces, the update screen flags it.
- **Prompts** always append. Changing a workflow's own prompts means
  detaching.
- Two packs carrying the same skill name: adding the second shows the clash
  and asks which wins; the answer is stored as pack order.

### 9. Packs

A pack is a linkable with no states. It is created in a project, added to
other projects from there or from the cloud, and updated, reverted and
detached exactly like a workflow. Its items carry no project-specific scope —
they cannot reference any project's states, labels or issues — so they are
portable.

**Env variables in workflows and packs.**

- A **secret** env item travels only as a *declaration* (name, description,
  hint). The project supplies the value when adding the linkable, as with
  declared variables. Until it is supplied the linkable is added but flagged
  *needs setup*, and a run whose context needs the missing value is not
  admitted.
- A **non-secret** env item travels with its value by default, and applies
  only where the linkable that carries it applies: a workflow's value only to
  issues in that workflow, a pack's value only where the pack applies (its
  narrowing, decision 10). It never becomes a project-wide variable. The
  project may override the value, which is a project-side setting and
  survives updates.

**Journals are always per project.** A journal (the prompt named `journal`,
`specs/context/AGENT_EDITING.md`) is project context. Workflows and packs
cannot carry one, publishing refuses content that contains one, and a
journal's entries never leave the project.

### 10. Where a pack applies inside a project

By default a pack's items apply to every issue in the project. The project
can **narrow** a pack link to particular workflows, states or labels (for
example, a *research with sources* pack only while in *Scouting*). Narrowing
is a project-side setting on the link and survives updates.

### 11. Publishing to the cloud

- Any **standalone** linkable can be published. A linked copy must be
  detached first, so you only ever publish content you control.
- Publishing leaves the local linkable standalone and marks it *published as
  X*. You keep editing it and choose when to publish the next version, which
  gets the next number, release notes, and a declared state mapping for any
  removed states.
- Projects that copy it from your project link to your project, not the
  cloud.
- Visibility is **private** (only you can add it) or **public** (listed).
  This builds on the existing immutable snapshots, moderation, and
  publication authority (`specs/library/PUBLICATIONS.md`): a version is a
  snapshot with a listing and a number.
- **Built-in workflows** are cloud listings published by Tines. Projects pull
  their updates like any other; nobody else can publish to them.

### 12. Migration

1. Create a **My Workflows** project for each user who owns a workflow or
   global context.
2. Move every user-owned workflow into it (`project_id` = My Workflows),
   assigning stable keys to all states.
3. For every project whose issues, default workflow or schedules use one of
   those workflows, **add** a linked copy with source = the original in My
   Workflows and mode **auto-update**, repointing issues, schedules, routing
   and context to the copy's states. This preserves today's "edit once,
   applies everywhere". A project can detach its copy to make it the root
   for that workflow; other projects keep following My Workflows.
4. System workflows (`user_id` NULL) become built-in cloud listings; each
   project using one gets a link to it.
5. Context items move by scope:

   | Scope today | Becomes |
   | --- | --- |
   | state only | workflow context of that state's workflow |
   | project, alone or with state / label | project context |
   | issue (with anything) | project context on that issue |
   | empty (global) | the user's **Personal** pack in My Workflows, linked into every project with auto-update |
   | label only | a **Personal · \<label\>** pack, linked into every project with auto-update and narrowed to that label |

   A `journal` is never moved into workflow context or a pack: one without a
   project in its scope is copied into project context in each project that
   uses its state. Nothing lands in user context automatically, so every
   launch prompt keeps its content and order; the user moves the truly
   personal items across deliberately.

## Data model sketch

Illustrative, not binding; a migration plan comes with implementation.

- `workflow.project_id` (replaces `user_id`); `workflow_state.key`.
- `context_pack` — `id`, `project_id`, `name`, `description`.
- `context_item` gains an owner: exactly one of `user_id` (user layer),
  `workflow_id` (workflow layer, scoped to one of its states),
  `project_id` (project layer, optional state / label / issue narrowing), or
  `pack_id`.
- `link` — `id`, `project_id`, `kind` (`workflow` | `pack`), `local_id`,
  `source_kind` (`project` | `cloud`), `source_id`, `mode` (`review` |
  `auto`), `applied_snapshot_id`, `paused_reason`.
- `link_snapshot` — immutable applied content per link, for diff and revert.
- `pack_link_narrowing` — workflow / state / label filters for a pack link.
- Cloud versions extend `workflow_publication` with a listing identity, a
  version number, release notes and a state mapping, and cover packs.

## Future

- **Schedules in workflows**: a publisher may ship an optional schedule with
  a recommended frequency; the project decides whether to enable it.
- **Permissions** for who may apply, revert and detach.
- **Specific-people visibility** for cloud listings.
- **Re-link a detached copy** to a newer source, with an agent porting the
  local edits — the original "agent re-applies my modifications" idea.
- **Move all links to a new root** after detaching.

## Open questions

- **Inheritance bases.** A state may inherit from a state in another
  workflow, including Standard. Proposed: a linked workflow's snapshot
  carries its bases (the export closure already does), materialized as
  read-only bases owned by the link; a Standard base becomes a link to the
  built-in.
- **One link per source per project** (decision 2) — under discussion.
