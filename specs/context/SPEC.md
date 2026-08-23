# Tines — Context Attachments Spec

Issues tell an agent *what* to do; context tells it *how*. This spec adds **context items** — prompts, skills, and repo pointers — that attach to issues, workflow states, and projects, and merge into a single **effective context** for any issue. The effective context is the bundle an agent would be launched with: a stitched prompt, skill directories to seed into its workspace, and repositories to check out.

**This spec covers creating, scoping, viewing, and assembling context — not delivering it to agents.** Agent consumption (the supervisor seeding workspaces, launching with the stitched prompt) comes with the supervisor phase. The only consumption surfaces here are the API, a read-only CLI command, and the web UI.

## Goals

- Attach typed context items (prompt / skill / repo) to issues, workflow states, and projects.
- Scope an item to an **intersection** of those dimensions — e.g. "only for issues in project X while in state *Implementing*".
- Deterministically assemble the effective context for an issue: prompts stitched broad→specific, skills and repos deduplicated with the most specific winning.
- View and edit context in place (on the issue, project, and workflow pages) and browse it all in one global Context tab.
- Keep the item model a **bucket that extends over time**: new kinds and new scope dimensions (roles, nested projects) must be addable without restructuring.

## Non-goals

- **Agent delivery**: no workspace seeding, no automatic prompt injection, no launching. The CLI can print/export the effective context; nothing acts on it.
- **Roles as entities**: the scope model is designed so a role dimension slots in later as one more column, but no role table, no role UI, no role filtering ships now.
- **Sharing/reuse across users**, and no library of shareable context bundles. Items belong to one user and are generally written for one scope.
- **Binary or large files**: skill files are small text files stored in D1. Uploads, binaries, and R2-backed bundles are future work.
- **Versioning**: items are mutable and live-referenced, like workflows. Edits emit events; no history.
- **Nested-project inheritance**: projects are still flat. The merge order is defined so that ancestor-project context can later prepend naturally (root→leaf), but nothing implements it.

## Concepts

### Context item

A typed, user-owned unit of context. Every item has:

- **Kind**: `prompt`, `skill`, or `repo`. The set is open-ended by design — kind is a string, and each kind carries its own payload shape. Future kinds (MCP server configs, environment variables, URL references) are added by defining a new kind, not a new table.
- **Name**: required, human-readable identifier. For skills it doubles as the directory name the skill would occupy in a workspace, so skill names are slug-like (`[a-z0-9-]+`). Names must be unique among items with the same kind **and the same scope** (two prompts named "conventions" on the same project would be ambiguous; the same name in different scopes is fine — that's the journal case).
- **Description**: optional one-liner shown in lists.
- **Scope**: see below.
- **Position**: an integer ordering items within the same scope (drag-to-reorder later; created order for now).
- Timestamps and (via events) an actor trail like every other mutation.

#### Kind payloads

- **`prompt`** — a Markdown body. The atom of prompt stitching. Size-capped (32 KB).
- **`skill`** — a set of text files, each with a workspace-relative **path** and **content**. Paths are validated: relative, forward slashes, no `..` or leading `/`, no duplicates within the skill. Caps: ≤ 20 files, ≤ 100 KB total per skill. This matches the SKILL.md-style pattern: a directory of instructions/scripts seeded into an agent's workspace at `skills/<name>/…`.
- **`repo`** — a pointer: **URL** (required), **branch** (optional), **checkout directory** (optional; defaults to the repo's basename). Tines stores no repository content — the consumer checks it out.

### Scope: intersection of dimensions

An item's scope is a set of optional dimensions, stored as nullable references on the item:

| Dimension | References | Meaning when set |
| --- | --- | --- |
| `project_id` | project | applies only to issues in this project |
| `workflow_state_id` | workflow state | applies only to issues currently in this state |
| `issue_id` | issue | applies only to this issue |

**At least one dimension must be set.** An item applies to an issue when **all** of its set dimensions match (logical AND). Examples:

- `project=Tines` — house conventions for every issue in the project.
- `state=Review` — a review checklist for any issue sitting in that state, in any project whose workflow includes it.
- `project=Tines ∧ state=Implementing` — the implementer's journal for this project: private notes on how to build features *here*, invisible to other projects and to other stages of work.
- `issue=Tines/42` — context for one issue; optionally `issue=Tines/42 ∧ state=Review` for one issue only while in review.

This is why scope is columns on the item rather than a join table per element: the journal case is a single row with two dimensions set, and a future **role** dimension (or a tag column matching an agent's declared role) is one more nullable column with the same AND semantics — no schema restructuring. Single-element attachment is just the one-dimension degenerate case, which the UI presents as "attach context to this issue/state/project".

**Coherence validation** (422 on violation):

- `issue_id` and `project_id` both set → the issue must belong to that project (the UI omits the redundant combination; the API tolerates it when coherent).
- `issue_id` and `workflow_state_id` both set → the state must belong to the issue's bound workflow.
- All referenced elements must belong to the authenticated user (states may also come from the system standard workflow).

`project ∧ state` combinations are *not* checked against the project's default workflow — issues choose workflows per issue, so any of the user's states may pair with any project. The UI surfaces a gentle hint when the pairing can never currently match (no issue in that project uses that state's workflow), but it is not an error.

### Effective context for an issue

The assembled bundle for issue *I* in project *P*, currently in state *S*: every item whose set dimensions all match *(P, S, I)*, organized as follows.

**Layer order (broad → specific):**

1. `project` only
2. `workflow_state` only
3. `project ∧ workflow_state`
4. anything with `issue_id` set (the issue's own context, most specific)

Within a layer, items order by `position`, then `created_at`. The rationale: general house rules first, then what-this-stage-of-work means, then the project-specific refinement of that stage, then this issue's particulars — each layer reads as a refinement of the previous. When nested projects arrive, ancestor projects' layers prepend before the project's own (root→leaf), which is why layer 1 comes first.

**Per-kind merge:**

- **Prompts concatenate.** Bodies are joined in layer order with blank-line separators into one stitched prompt. No deduplication — every matching prompt contributes. The API also returns the parts individually, each labeled with its source scope, so consumers can render or re-stitch with attribution.
- **Skills dedupe by name.** Two matching skills with the same name collide; the most specific layer wins (later layer order beats earlier; within a layer this can't happen — names are unique per scope). This is the override mechanism: an issue-scoped `deploy` skill replaces the project's `deploy` skill wholesale (no file-level merging).
- **Repos dedupe by URL** (exact string match after trimming). Most specific wins, so an issue can pin a different branch of the project's repo by re-declaring the same URL.

The effective context is computed on read — nothing is materialized or snapshotted. Because state is a dimension, **an issue's effective context changes as it transitions**; that is a feature (review context appears in review), and the issue page makes the dependence visible.

### Events

New event types in the global stream, emitted transactionally like all others:

- `context.created`, `context.updated`, `context.deleted` — payload: item id, kind, name, and its scope (ids + display names at event time). Events carry the item's `project_id`/`issue_id` in the standard event reference columns when set, so they appear in the project's and issue's filtered feeds.

`context.updated` uses a summary-diff payload in the spirit of `workflow.updated`: which fields changed; for skills, files added/removed/modified by path.

### Lifecycle rules

Context items follow their scope anchors:

- **Deleting a project** is already only allowed when it has no issues; it now also requires no context items scoped to it (or, equivalently, deletes them — the API deletes and reports the count; the UI confirms with the count).
- **Deleting a workflow state** is allowed only when no issue sits in it (existing rule); if context items are scoped to the state, the API rejects unless a `force` flag is passed, in which case the items are deleted and reported. The workflow editor shows which states carry context.
- **Issues** cannot be deleted in phase one, so issue-scoped items have no orphan path.
- An item that loses one anchor of a multi-dimension scope is deleted with it (there is no "partially scoped" leftover).

## Data model (D1 / Kysely)

```
context_item        id, user_id, kind, name, description?,
                    project_id?, workflow_state_id?, issue_id?,     -- scope; ≥1 set (CHECK)
                    body?,                                          -- prompt: markdown
                    repo_url?, repo_branch?, repo_dir?,             -- repo pointer
                    position, created_at, updated_at
                    -- unique on (user_id, kind, name,
                    --            project_id, workflow_state_id, issue_id)
context_item_file   id, context_item_id, path, content, created_at, updated_at
                    -- skill files; unique on (context_item_id, path)
```

Notes:

- Kind-specific payloads live as nullable columns (`body` for prompts, `repo_*` for repos) plus the child file table for skills. A future kind with a structured payload can use a JSON `config` column added at that time; the row shape above deliberately leaves room rather than pre-adding it.
- The uniqueness constraint treats NULL scope columns as distinct in SQLite, so it is enforced in the API layer (same pattern as other cross-row validations), with the index kept for lookups.
- No `role` column yet; adding one later is a single nullable column + one more AND clause in the matching query.
- The matching query for an issue is a straightforward `WHERE user_id = ? AND (project_id IS NULL OR project_id = ?) AND (workflow_state_id IS NULL OR workflow_state_id = ?) AND (issue_id IS NULL OR issue_id = ?)` over the user's items — fine at per-user scale on D1.

## API

Under `/api/v1/*` with the existing auth and conventions (cursor pagination, structured 422s, cross-user 404s).

| Method & path | Purpose |
| --- | --- |
| `GET /api/v1/context` | List items; filters: `kind`, `project`, `state`, `issue`, `q` (name/description search). Default lists all the user's items; `scoped_to=` filters to items whose scope includes the given element. |
| `POST /api/v1/context` | Create an item: kind, name, scope, payload (prompt body / skill files / repo fields) in one request. |
| `GET/PATCH/DELETE /api/v1/context/:id` | Read (skills include files) / update (payload, name, description, scope, position) / delete. |
| `GET /api/v1/issues/:id/context` | **Effective context.** Returns the ordered matching items with source-scope labels, plus the assembled view: `{ prompt: { text, parts: [...] }, skills: [...], repos: [...] }` after stitching and dedup. Collisions that were overridden are reported (`overridden_by`) so the UI can show them. |

Skill file edits go through `PATCH /api/v1/context/:id` with the full file list (declarative replace — the item is small by construction; no per-file endpoints).

The issue read (`GET /api/v1/issues/:id`) gains a lightweight `context_summary` (counts per kind of the currently-effective context) so lists and the issue page can badge issues that carry context without fetching bodies.

## CLI

```
tines context list [--project <name>] [--state <name>] [--issue <ref>] [--kind <k>]
tines context show <id>
tines context create --kind prompt --name <n> [scope flags] --body <md|@file>
tines context create --kind skill  --name <n> [scope flags] --file <path>=<@file>...
tines context create --kind repo   --name <n> [scope flags] --url <u> [--branch <b>]
tines context edit <id> [...]        # same flags as create
tines context delete <id>
tines issues context <project>/<number> [--json] [--out <dir>]
```

Scope flags: `--project <name>`, `--state <workflow>/<state>`, `--issue <project>/<number>`, combinable per the intersection rules.

`tines issues context` is the consumption stub: it prints the stitched prompt (or the full structure with `--json`), and `--out <dir>` writes the bundle to disk — `prompt.md`, `skills/<name>/<files…>`, and `repos.json` — which is exactly the shape a launcher script or future supervisor would seed into a workspace. Nothing else consumes context yet.

## Web UI

### Global Context tab

A fifth nav tab, **Context** (`/context`): all items in a filterable table — kind (icon + label), name, scope (compact chips: project / state / issue), updated. Filters mirror the API's; search by name. Create from here with a full scope picker, or edit any item in place. This is the one surface where cross-cutting items (`project ∧ state`) are first-class citizens rather than appearing "half" on two pages.

### In-place sections

- **Issue detail** gains a **Context** panel with two parts:
  - **This issue's context**: items scoped to the issue (any item with this `issue_id`), with inline create/edit — the quick path for "give this issue a note/skill/repo".
  - **Effective context** (collapsed by default): the assembled bundle — the stitched prompt rendered with a subtle source badge per part (e.g. *from project Tines*, *from state Review*), the skill list, the repo list, and any overridden items shown struck-through with what beat them. A caption notes the current state, since transitioning changes the set; when the issue transitions, the panel updates with the same animation language as the rest of the page (entering/leaving items slide/fade, respecting `prefers-reduced-motion`).
- **Project detail** gains a **Context** section listing every item whose scope includes this project — plain project items first, then `project ∧ state` items grouped under their state names. Inline create defaults the scope to this project, with an optional "only in state…" refinement.
- **Workflow detail** shows, per state, a small context indicator (count badge on the state's row/node); selecting a state reveals its items — both `state`-only and `project ∧ state` (labeled with their project). Inline create defaults to that state. This is also where state deletion warns about attached context.

### Item editor

One dialog/page for all kinds — kind picker up front, then:

- **Prompt**: name, description, Markdown editor with preview (same component as issue descriptions).
- **Skill**: name (slug-validated), description, and a small file editor — a file list (add/rename/remove paths) with a text editor per file; validation errors (bad path, size caps) inline.
- **Repo**: name, URL, branch, checkout dir.

Plus the scope picker: three optional selectors (project, workflow → state, issue) rendered as removable chips, with the coherence rules enforced live (picking an issue constrains the state list to its workflow, etc.).

## Alternatives considered

- **A shared context library attached by reference** (like the workflow library). Rejected: context is expected to be written for one scope and rarely shared; a library adds a naming/management layer for little reuse. The `context_item` table stands alone, so a library (named, unscoped items + an attachment join) can be layered on later without migrating existing rows.
- **One join table per element type** (`issue_context`, `state_context`, `project_context`). Rejected: cannot express intersection scopes like the project-journal case without duplicating items, and every new dimension means a new table. Nullable scope columns give AND-composition for free.
- **Context as a single JSON document per element.** Rejected: items must be individually addressable — for override-by-name, for events, for future role filtering — and a JSON blob makes all of that opaque.
- **Skills as git-repo references or R2 bundles** instead of inline files. Deferred: inline text files in D1 need no new infrastructure and are viewable/editable in the web UI, which this phase prioritizes. The `repo` kind already covers "the real content lives in git"; R2 bundles can become a fourth kind if binaries/large assets are ever needed.
- **User-controlled global ordering** (priority across layers). Rejected for now: fixed broad→specific layering plus per-scope `position` is predictable and covers the stated cases; full ordering control adds UI weight before there's evidence it's needed.
- **Role filtering now.** Deferred by design: the intersection model was chosen so a role dimension is additive. Shipping a role column before agents/roles exist as entities would freeze semantics ahead of the supervisor phase.

## Acceptance criteria

Done when this loop works end-to-end:

1. Create a prompt scoped to project *Tines* ("house conventions"), a skill scoped to state *Review* (a `review-checklist` with two files), and a prompt scoped to *Tines ∧ Implementing* (the journal note).
2. An issue in *Tines* sitting in *Implementing* shows an effective context containing the house prompt followed by the journal note; the review skill is absent. `tines issues context tines/1` prints the same stitched prompt; `--out` writes `prompt.md` and no skills.
3. Transition the issue to *Review*: the journal note leaves the effective context, the `review-checklist` skill appears, and the panel animates the change.
4. An issue in a *different* project in state *Implementing* gets neither the house prompt nor the journal note — the intersection held.
5. Attach an issue-scoped skill also named `review-checklist` to the issue: the effective view shows it overriding the state-level one, with the loser visibly struck through and reported as `overridden_by` in the API.
6. All creates/edits/deletes appear in the activity feed (and on the issue's/project's filtered feeds) with correct actor attribution, including via API key.
7. Deleting the *Review* state without `force` is rejected with an error naming the attached context; the Context tab lists every item with accurate scope chips and filters.

## Resolved questions

- **Reusable library vs. per-element**: per-element (scoped items in their own table); contexts are rarely shared. A library remains layerable later.
- **Granularity**: typed items attached directly — no container entity, no JSON blob.
- **Skill storage**: inline text files in D1, size-capped; no R2, no binaries.
- **Merge semantics**: concat broad→specific for prompts; dedupe by key (skill name / repo URL) with the most specific layer winning.
- **Scoping model**: intersection (AND) of optional dimensions on the item — chosen over role tags after the journal example showed the real need is *project ∧ state* conditioning; roles become one more dimension later.
- **Web UI**: in-place sections on issue/project/workflow pages plus a global Context tab, with an effective-context preview on the issue page.
