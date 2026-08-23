# Tines — Phase One Spec

Tines is an orchestration layer for AI agents: an ecosystem of agents collaborating with you toward your goals. Its core is an issue tracker that makes work legible to both humans and agents — a log of work, actions taken, and handoffs — where issues move between states according to workflows (finite state machines). Later phases add a supervisor that assigns work to agents on managed services and local devices.

**Phase one builds the tracker only.** Agents participate purely as API clients: a human (or an agent someone launched themselves) uses the API/CLI to read issues, comment, and move them through their workflow. Tines does not assign, launch, or supervise anything yet.

## Goals

- Issues organized into per-user projects, moving through user-defined workflows with enforced transitions.
- A comment thread per issue and a global activity log, so the history of work and handoffs is legible.
- Three surfaces over one API: web UI, CLI, and the HTTP API itself (for agents).
- Named API keys so actions by agents are attributable and distinguishable from the user's own.

## Non-goals (phase one)

Explicitly out of scope, even where the data model anticipates them:

- **Supervision/execution**: no assignment, no launching agents, no managed services or local runners.
- **Roles/permissions**: workflows are states + transitions only; anyone authenticated as the owner (session or API key) can perform any action. Per-state roles come with the supervisor.
- **Collaboration**: no teams, no sharing, no workflow publishing. Everything belongs to a single user.
- **Project hierarchy**: projects are a single flat layer per user. (Trees come later — the schema must not preclude adding `parent_id`.)
- **Issue metadata**: no assignee, labels, priority, or due dates.
- **Issue deletion/archival**: moving an issue to a `done` state is the only way to finish it; deleting issues (and the audit questions it raises) is deferred.
- **Drag-and-drop workflow editing**: workflows always render as a visual graph, but the graph is not an editing surface — creating and editing happens through a form. Manual node positioning and edge-drawing come later, if ever.

## Concepts

### User

An authenticated account (Better Auth, Google sign-in — already in place). Every project, workflow, issue, event, and API key belongs to exactly one user.

### Project

A named container for issues. Flat list per user. A project may set a **default workflow** used to pre-select the workflow when creating issues in it.

### Workflow

A finite state machine owned by a user and stored in their **workflow library**, shared across all their projects (a solid engineering workflow or QA pipeline is reusable; later phases add publishing workflows for others and team libraries).

A workflow is:

- A set of **states**, each with a stable id, a name (unique within the workflow), and a **category**.
- Exactly one **initial state**, where newly created issues land.
- A set of **transitions**: directed `(from state → to state)` pairs. Only listed transitions are allowed; there are no implicit transitions.

**State categories.** State names are free-form, so categories are how Tines understands what a state *means* across arbitrary workflows:

| Category | Meaning |
| --- | --- |
| `backlog` | Not yet ready to be worked. |
| `active` | Ready to be taken on, or being worked. |
| `awaiting_human` | Blocked on human feedback. |
| `done` | Finished — no further work expected. |

Categories drive default filtering (the Issues tab hides `done` by default), color-coding in lists and the graph view, and — in phase two — the supervisor's behavior (agents pick up `active` work and never touch `awaiting_human`). The initial state must be `backlog` or `active`.

Validation on create/update: at least one state; exactly one initial state, categorized `backlog` or `active`; state names unique; every state categorized; transitions reference states in the same workflow; no duplicate transitions; self-transitions rejected.

**The standard workflow.** Tines ships one built-in, read-only system workflow available to every user:

| State | Category | Meaning |
| --- | --- | --- |
| **Open** (initial) | `active` | Ready to be taken on, or currently being worked. |
| **Human Review** | `awaiting_human` | Work is done and awaiting a human's judgment. |
| **Closed** | `done` | Finished or abandoned. |

Transitions: `Open → Human Review`, `Human Review → Open` (sent back for more work), `Human Review → Closed`, `Open → Closed` (abandon). The standard workflow cannot be edited or deleted; users copy it into their library if they want a variant.

**Editing rules (restrict edits).** Issues reference workflows live — there is no per-issue snapshot or versioning in phase one. To keep in-flight issues valid, the API rejects edits that would strand them:

- A state cannot be deleted while any issue currently sits in it.
- The initial state cannot be deleted; to remove it, first designate another state as initial.
- A workflow cannot be deleted while any issue references it.
- Renaming states, adding states, and adding transitions are always allowed. Issues reference states by id, so renames never break references.
- Removing a transition is allowed (it doesn't invalidate any issue's current state), but the API warns when it leaves a non-terminal state with no outgoing transitions.

### Issue

The unit of work. An issue has:

- **Project** (required, set at creation; moving between projects is out of scope for phase one).
- **Number**: per-project sequential integer (`#1`, `#2`, …), assigned at creation, never reused. Issues are addressed as `<project>/<number>` in the CLI and URLs, plus a globally unique id for the API.
- **Title** (plain text) and **description** (Markdown).
- **Workflow binding**: chosen per issue at creation from the user's library (defaulting to the project's default workflow, else the standard workflow). Immutable after creation in phase one.
- **State**: a state id from the bound workflow. New issues start in the workflow's initial state. State changes go through a dedicated transition operation, which rejects anything not in the workflow's transition set.

### Comment

A Markdown comment on an issue — the medium through which humans and agents narrate work and hand off context. Comments record their actor (see Actors below) and timestamp. Phase one: create and list; no editing or deleting.

### Activity log (events)

A **global, append-only event stream per user** — not a per-issue feature. Events may reference an issue and/or project, but the stream is designed to also carry event types with no issue attached (later: agent lifecycle, supervisor decisions). The issue view filters the stream to that issue's events; a global feed shows everything.

Each event records: type, actor, optional issue/project references, a small JSON payload (e.g. from/to state ids for a transition), and a timestamp.

Phase-one event types:

- `issue.created`, `issue.updated` (title/description), `issue.transitioned`, `issue.commented`
- `project.created`, `project.updated`, `project.deleted`
- `workflow.created`, `workflow.updated`, `workflow.deleted`
- `api_key.created`, `api_key.revoked`

Events are emitted by the API layer in the same transaction as the change they describe. The set is open-ended by design: new types must be addable without migration (type is a string, payload is JSON).

### API keys and actors

Browser sessions authenticate via Better Auth as today. The CLI and agents authenticate with **named API keys**:

- Created and revoked in the web UI (name + creation date + last-used shown; secret shown once at creation).
- Sent as `Authorization: Bearer <key>`. Keys are stored hashed; a short prefix is kept for display.
- The CLI reads the key from `TINES_API_KEY` (or `--api-key`), so an agent launched with that variable set picks it up automatically. Base URL from `--url` / `TINES_API_URL` as today.

Every mutating action records its **actor**: the user via a browser session, or a specific named API key. Comments and events display the actor ("tbuckley" vs. "via *laptop-claude*"), which is what makes agent work distinguishable from human work in the log. A key acts with the full authority of its owner (no scoped permissions in phase one).

## Data model (D1 / Kysely)

New tables alongside the existing Better Auth tables. All ids are opaque strings (e.g. nanoid); timestamps are ms-since-epoch integers.

```
project             id, user_id, name, description, default_workflow_id?, created_at, updated_at
workflow            id, user_id?,  name, description, initial_state_id, created_at, updated_at
                    -- user_id NULL = system workflow (the standard workflow, seeded by migration)
workflow_state      id, workflow_id, name, category, position, created_at
                    -- category: 'backlog' | 'active' | 'awaiting_human' | 'done'
workflow_transition id, workflow_id, from_state_id, to_state_id   (unique on the triple)
issue               id, project_id, number, title, description, workflow_id, state_id,
                    created_at, updated_at                        (unique on project_id+number)
comment             id, issue_id, body, actor_user_id, actor_api_key_id?, created_at
event               id, user_id, type, actor_user_id, actor_api_key_id?,
                    issue_id?, project_id?, payload(JSON), created_at
api_key             id, user_id, name, key_hash, key_prefix, created_at, last_used_at?, revoked_at?
```

Notes:

- `event.user_id` is the stream owner (whose feed it appears in), distinct from the actor fields.
- `actor_api_key_id` NULL means the user acted directly (browser session); set means that key acted.
- Issue `number` is allocated per project with a transactional `MAX(number)+1` (D1 requests are single-writer enough for phase one; revisit if it ever contends).
- `project` gets no `parent_id` yet, but nothing may assume projects are leaf-only (no flat-list uniqueness constraints on name, etc.) so trees can be added later.

## API

JSON over HTTP under `/api/v1/*`, served by the SvelteKit app; shared request/response types live in `@tines/shared`. Auth: Better Auth session cookie or bearer API key. All resources are scoped to the authenticated user; cross-user access is a 404.

| Method & path | Purpose |
| --- | --- |
| `GET/POST /api/v1/projects` | List / create projects |
| `GET/PATCH/DELETE /api/v1/projects/:id` | Read / update (name, description, default workflow) / delete (only when issue-less) |
| `GET/POST /api/v1/workflows` | List library (incl. standard) / create |
| `GET/PATCH/DELETE /api/v1/workflows/:id` | Read (with states + transitions) / update per editing rules / delete when unreferenced |
| `GET /api/v1/issues` | Global list across projects; filters: `project`, `state`, `category`, `workflow` |
| `GET/POST /api/v1/projects/:id/issues` | List (filter by state/category) / create |
| `GET/PATCH /api/v1/issues/:id` | Read (incl. workflow, state, comments) / update title & description |
| `POST /api/v1/issues/:id/transition` | `{ to_state_id }`; 422 with the allowed transitions when invalid |
| `GET/POST /api/v1/issues/:id/comments` | List / add comment |
| `GET /api/v1/events` | Global feed, newest first; filters: `issue`, `project`, `type`; cursor pagination |
| `GET/POST /api/v1/api-keys`, `DELETE /api/v1/api-keys/:id` | Manage keys (create/revoke require a browser session, not a key) |

All list endpoints use the same cursor-pagination convention (`?cursor=…&limit=…`, response carries `next_cursor`), newest first for issues and events.

Validation failures (workflow editing rules, illegal transitions) return structured errors naming what was violated and, where applicable, what *is* allowed — agents should be able to recover from a 422 without human help.

Markdown (descriptions, comments) is stored raw and sanitized at render time in the web UI — agents post arbitrary Markdown, so rendering must be XSS-safe.

## CLI

`tines` talks to the same API. Phase-one commands:

```
tines projects list | create <name>
tines workflows list | show <id-or-name>
tines issues list [--project <name>] [--state <name>] [--category <cat>] [--all]
                                          # hides done issues unless --all
tines issues create <project> --title <t> [--description <md>] [--workflow <id-or-name>]
tines issues show <project>/<number>
tines issues move <project>/<number> <state-name>
tines issues comment <project>/<number> <markdown>
tines events list [--issue <ref>] [--project <name>] [--limit n]
```

All commands support `--json` for agent consumption. `issues show --json` includes the allowed next transitions, so an agent always knows its legal moves.

## Web UI

SvelteKit + shadcn-svelte, behind sign-in.

### Structure

A persistent top nav with four tabs — **Issues, Workflows, Projects, Activity** — each a list view with a corresponding detail page. Settings (API keys, account) live under the avatar menu, not in the tabs.

- **Issues** (`/issues`): the default landing tab — a global list across all projects, hiding `done` issues by default. Filter by project, state, and category; rows show number, title, project, state (color-coded by category), and last activity. → detail at `/issues/:project/:number`.
- **Workflows** (`/workflows`): the library, standard workflow marked read-only. → detail at `/workflows/:id`.
- **Projects** (`/projects`): list + create. → detail at `/projects/:id`: the project's issues (same list component as the Issues tab, pre-filtered), a new-issue form, and project settings (name, description, default workflow).
- **Activity** (`/activity`): the global event feed, newest first, filterable by project and type — the "log of work" made visible. Each event links to its issue/project.
- **Settings → API keys** (avatar menu): create (secret shown once), list with last-used, revoke.

### Key pages

- **Issue detail**: title, rendered Markdown description (editable), state with allowed-transition buttons plus a compact graph of the issue's workflow with the current state highlighted, comment thread, and this issue's slice of the activity log — with actors shown throughout.
- **Workflow detail/editor**: two views of the same FSM, side by side:
  - A **graph view** — the primary way a workflow is *read*. States are nodes (color-coded by category; initial and dead-end states visually distinguished), transitions are directed edges, laid out automatically client-side (no stored positions, no manual arranging). Shown wherever a workflow appears: the detail page, the editor, and as a compact preview when picking a workflow at issue creation.
  - A **form-based editor** — the way a workflow is *written*: add/rename/remove states, set each state's category, pick the initial state, per-state pickers for allowed target states. The graph re-renders live as the form changes, so the user sees the machine they're building. Editing-rule violations surface inline.

### Look and feel

Modern and calm, with **meaningful animation** — motion always communicates a change, never decorates:

- Transitioning an issue animates the state change where it happens: the highlight moves along the transition edge in the workflow graph, and the row/badge morphs to the new state in lists.
- List ↔ detail navigation uses shared-element/view transitions (Svelte 5 transitions / the View Transitions API) so the item you clicked visibly becomes the page you land on.
- New activity events and comments enter with a subtle slide/fade; reordered or refiltered lists animate with FLIP rather than snapping.
- Micro-interactions (buttons, dialogs, popovers) use the shadcn-svelte defaults; durations stay short (~150–250ms) and consistent.
- All motion respects `prefers-reduced-motion`, falling back to instant changes.
- Loading is skeleton-first, not spinner-first; optimistic UI for comments and transitions with rollback on API rejection.

## Acceptance criteria

Phase one is done when this loop works end-to-end:

1. Sign in with Google; create a project and an API key named `my-agent`.
2. Create a workflow in the library via the form editor; set it as the project's default.
3. `TINES_API_KEY=… tines issues create …` — the issue starts in the workflow's initial state.
4. An agent (any process holding the key) lists issues, comments, and `tines issues move`s an issue through a legal transition; an illegal move is rejected with the allowed transitions.
5. The web UI shows the comment and transition attributed to *my-agent*; the global activity feed and the issue's filtered log both show the trail; the state change animates in the issue's workflow graph.
6. Once the issue reaches a `done` state, it disappears from the default Issues tab view (and reappears with the done filter on).
7. Deleting an in-use workflow state via UI or API is rejected with a clear error.

## Open questions

- Naming of the standard workflow's initial state: **Open** is the working choice (implies "ready to be taken on / being worked" without a separate backlog state); alternatives: `Ready`, `Active`.
- Whether `workflow.updated` events should record a diff of the change in the payload, or just "it changed."
- Whether issue *description* edits belong in the comment thread as a visible event only, or should also keep revisions (phase one: event only, no revision history).
