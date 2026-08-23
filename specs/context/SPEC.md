# Tines — Context Attachments Spec

Issues tell an agent *what* to do; context tells it *how*. This spec adds **context items** — prompts, skills, and repo pointers — that attach to issues, workflow states, and projects, and merge into a single **effective context** for any issue. The effective context is the bundle an agent would be launched with: a stitched prompt, skill directories to seed into its workspace, and repositories to check out.

**This spec covers creating, scoping, viewing, and assembling context — not delivering it to agents.** Agent consumption (the supervisor seeding workspaces, launching with the stitched prompt) comes with the supervisor phase. The only consumption surfaces here are the API, a read-only CLI command, and the web UI.

## Goals

- Attach typed context items (prompt / skill / repo) to issues, workflow states, and projects.
- Scope an item to an **intersection** of those dimensions — e.g. "only for issues in project X while in state *Implementing*".
- Deterministically assemble the effective context for an issue: prompts stitched broad→specific, skills and repos deduplicated by name with the most specific winning.
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

- **Kind**: `prompt`, `skill`, or `repo`. The set is open-ended *by design*, not by API laxity: kind is a string and each kind carries its own payload shape, so a future kind (MCP server config, environment variables, URL reference) is an additive change. The API is **strict now**: an unknown kind is a 422, and payload fields that don't belong to the declared kind are rejected, not dropped. Kind is immutable after creation (422 on attempts to change it).
- **Name**: required, non-empty after trimming, ≤ 100 characters. For skills it doubles as the directory name the skill would occupy in a workspace, so skill names are slug-like (`[a-z0-9-]+`). Names must be unique among items with the same kind **and the same exact scope** (two prompts named "conventions" on the same project would be ambiguous; the same name in different scopes is fine — that's the override mechanism, see merging).
- **Description**: optional one-liner shown in lists.
- **Scope**: see below.
- **Position**: an integer ordering items within the same exact scope tuple (across kinds — the scope's items form one sequence). Auto-assigned `max+1` within the scope at creation; settable via PATCH to reorder (drag-to-reorder UI later). When an item is re-scoped, it re-appends at the end of the target scope's sequence.
- Timestamps and (via events) an actor trail like every other mutation.

#### Kind payloads

- **`prompt`** — a Markdown body. The atom of prompt stitching. Capped at 32 KB.
- **`skill`** — a set of text files, each with a workspace-relative **path** and **content**. Paths are validated: relative, forward slashes, no `..` or leading `/`, no `=`, no duplicates within the skill. Caps: ≤ 20 files, ≤ 100 KB total per skill. This matches the SKILL.md-style pattern: a directory of instructions/scripts seeded into an agent's workspace at `skills/<name>/…`.
- **`repo`** — a pointer: **URL** (required), **branch** (optional), **checkout directory** (optional; defaults at read time to the URL's basename with any trailing `.git` stripped). Tines stores no repository content — the consumer checks it out.

All caps are measured in bytes of UTF-8 and enforced at the API layer with structured 422s; clients (including the CLI) just relay the error.

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

**Scope display label.** Wherever a scope is rendered as text — UI badges, stitched-prompt headings, event payloads — it uses one canonical format: set dimensions in the order project · state · issue, joined with `·`, each as `<dimension> <display name>` (issues as `<project>/<number>`). E.g. `project Tines · state Review`.

**Coherence validation** (422 on violation):

- `issue_id` and `project_id` both set → the issue must belong to that project (the UI omits the redundant combination; the API tolerates it when coherent).
- `issue_id` and `workflow_state_id` both set → the state must belong to the issue's bound workflow.
- All referenced elements must belong to the authenticated user (states may also come from the system standard workflow).

`project ∧ state` combinations are *not* checked against the project's default workflow — issues choose workflows per issue, so any of the user's states may pair with any project. The UI surfaces a gentle hint when the pairing can never currently match (no issue in that project uses that state's workflow), but it is not an error.

### Effective context for an issue

The assembled bundle for issue *I* in project *P*, currently in state *S*: every item whose set dimensions all match *(P, S, I)*, organized as follows.

**Layer order — by specificity, broad → specific.** Matching items are grouped by their exact scope tuple; scopes order by **number of dimensions set** (fewer first), tie-broken by a fixed dimension precedence in which issue-anchored scopes outrank state-anchored ones, which outrank project-anchored ones. Concretely, the seven possible scopes order:

1. `project`
2. `state`
3. `project ∧ state`
4. `issue`
5. `issue ∧ project`
6. `issue ∧ state`
7. `issue ∧ project ∧ state`

Within a layer, items order by `position`, then `created_at`, then `id` (timestamps are ms integers and can tie). Because names are unique per exact scope and every exact scope is its own layer, **within-layer collisions are impossible by construction**. The rationale for the order: general house rules first, then what-this-stage-of-work means, then refinements — each layer reads as a refinement of the previous. The rule is generative, not enumerated: a future role dimension slots into the same specificity-count ordering without re-deciding anything. When nested projects arrive, ancestor projects' layers prepend before the project's own (root→leaf).

**Per-kind merge:**

- **Prompts concatenate.** Bodies join in layer order into one stitched prompt. Each body is trimmed of leading/trailing whitespace and preceded by a heading naming its source: `## Context: <scope label>` (e.g. `## Context: project Tines · state Review`); heading, body, and subsequent parts are separated by exactly one blank line (`\n\n`). No other text is injected. Authors write plain bodies knowing they will sit under a `##` heading. No deduplication — every matching prompt contributes. The API also returns the parts individually so consumers can re-stitch or render with richer attribution.
- **Skills and repos dedupe by name** — one uniform rule across kinds. Two matching items of the same kind with the same name collide; the later (more specific) layer wins wholesale — no file-level or field-level merging. This is the override mechanism: an issue-scoped `deploy` skill replaces the project's `deploy` skill; to pin a different branch of the project's repo for one issue, create an issue-scoped repo item with the **same name** and the branch you want. Repo URLs are never compared or normalized — identity is the name.
- **Repo checkout collisions.** After dedup, if two effective repos resolve to the same checkout directory, both are kept but the response flags the conflict (see API); `tines issues context --out` refuses to write while a conflict exists.

The effective context is computed on read — nothing is materialized or snapshotted. Because state is a dimension, **an issue's effective context changes as it transitions**; that is a feature (review context appears in review), and the issue page makes the dependence visible. A future supervisor must read the effective context **after** taking the transition it acts on (or snapshot at launch — a supervisor-phase concern); this spec deliberately does not freeze context at any point.

### Launch prompt for an issue

Context items are just context — background an agent works *within*. For an agent to actually take on an issue it also needs the issue itself. The **launch prompt** is the full text an agent would be started with: the stitched context followed by a generated **issue block** containing the issue's title, description, current state, comments, and available transitions.

The issue block is generated (not a context item), formatted as:

```markdown
## Issue: <project>/<number> — <title>

<description markdown, verbatim>

### Current state

<state name> (<category>), in workflow "<workflow name>".

### Comments

**<actor>** (<timestamp, ISO 8601>):
<comment markdown, verbatim>

*(chronological; "No comments yet." when empty)*

### Available transitions

- **<action name>** → <target state name> (<category>)
```

Assembly order is context first, issue block last — the same specific-things-last logic as the layer ordering: the agent reads how to work, then what the work is, with the task nearest the end of the prompt. The issue block is purely factual; any instructions (what "being in Review" means, how to report back) belong in context items — state-scoped prompts are the natural home for stage instructions. Tines injects no directive text of its own; that is supervisor-phase territory.

The launch prompt is a read-time formatting of data that already exists, so it stays perfectly in sync with the issue and emits no events. Launching agents with it is explicitly out of scope — for now the user copies it from the UI, or an agent reads it via the CLI.

### Events

New event types in the global stream, emitted transactionally like all others:

- `context.created`, `context.updated`, `context.deleted` — payload: item id, kind, name, and its scope (ids plus the display label at event time).

**Event references** are *derived* from the scope so feeds stay consistent: the event's `issue_id` is set when the item is issue-scoped, and its `project_id` is set when the item is project-scoped **or** derived from the issue's project when issue-scoped — so issue-anchored context events appear in both the issue's and the project's filtered feeds, matching how phase-one issue events behave. Events for `state`-only items carry no issue/project references and appear only in the global feed; that is intended and worth knowing.

`context.updated` uses a summary-diff payload in the spirit of `workflow.updated`: which fields changed; for skills, files added/removed/modified by path; for scope changes, both the old and new scope (ids + labels).

### Lifecycle rules

One uniform rule for every anchor that context is scoped to — **reject by default; `force` cascades**:

- **Deleting a project** (`DELETE /api/v1/projects/:id`), **deleting a workflow** (`DELETE /api/v1/workflows/:id`), and **removing a workflow state** (via the whole-workflow `PATCH /api/v1/workflows/:id`, where states are edited) are rejected with a 422 naming the attached context items whenever any item's scope references the deleted element (for workflows: any of their states). Existing phase-one guards (no issues in the project / state / workflow) still apply first.
- Each of these requests accepts **`force_delete_context: true`** in the body. With it, the operation proceeds and every attached item is deleted — all-or-nothing per request, even when one PATCH removes multiple states. The response reports the deleted items, and each one emits its own `context.deleted` event, attributed to the deleting actor, in the same transaction.
- **Issues** cannot be deleted in phase one, so issue-scoped items have no orphan path.
- An item whose scope references a force-deleted anchor is deleted entirely, even if its other dimensions survive (there is no "partially scoped" leftover).

The workflow editor shows which states carry context, and the UI confirmation dialogs list what a forced delete will sweep.

## Data model (D1 / Kysely)

```
context_item        id, user_id, kind, name, description?,
                    project_id?, workflow_state_id?, issue_id?,     -- scope; ≥1 set (CHECK)
                    body?,                                          -- prompt: markdown
                    repo_url?, repo_branch?, repo_dir?,             -- repo pointer
                    position, created_at, updated_at
context_item_file   id, context_item_id, path, content, created_at, updated_at
                    -- skill files; unique on (context_item_id, path)
```

Notes:

- Kind-specific payloads live as nullable columns (`body` for prompts, `repo_*` for repos) plus the child file table for skills. A future kind with a structured payload can use a JSON `config` column added at that time; the row shape above deliberately leaves room rather than pre-adding it.
- A **non-unique** index on `(user_id, project_id, workflow_state_id, issue_id)` supports the matching and listing queries. Name-uniqueness per (kind, exact scope) is enforced **only in the API layer** — a partial-NULL unique index can't express it in SQLite, and a half-enforcing unique index would surface raw constraint errors on the non-NULL cases instead of structured 422s.
- No `role` column yet; adding one later is a single nullable column + one more AND clause in the matching query.
- The matching query for an issue is a straightforward `WHERE user_id = ? AND (project_id IS NULL OR project_id = ?) AND (workflow_state_id IS NULL OR workflow_state_id = ?) AND (issue_id IS NULL OR issue_id = ?)` over the user's items — fine at per-user scale on D1.

## API

Under `/api/v1/*` with the existing auth and conventions (cursor pagination, structured 422s, cross-user 404s).

| Method & path | Purpose |
| --- | --- |
| `GET /api/v1/context` | List items, ordered `updated_at` desc then `id` (stable cursors). Filters: `kind`, `project`, `state`, `issue`, `q` (name/description search). |
| `POST /api/v1/context` | Create an item: kind, name, scope, payload (prompt body / skill files / repo fields) in one request. |
| `GET/PATCH/DELETE /api/v1/context/:id` | Read (skills include files) / update / delete. |
| `GET /api/v1/issues/:id/context` | **Effective context** — see response shape below. |
| `GET /api/v1/issues/:id/prompt` | **Launch prompt** — `{ "text": "…" }`, the stitched context plus the generated issue block. A pure formatter over the context response and the issue read; consumers needing structure use those endpoints. |

**List filter semantics — "scope includes".** `project=X` matches every item whose scope includes project X (project-only, `project ∧ state`, `issue ∧ project`, …); likewise `state=` and `issue=`. Multiple dimension filters AND together. Adding **`exact=true`** restricts to items whose scope sets *only* the given dimensions — the editor's "items scoped exactly here" views. There is no separate `scoped_to` parameter.

**PATCH semantics.** Merge-patch style: omitted fields are unchanged; an explicit `null` unsets a nullable field (this is how a scope dimension is removed — subject to the ≥1-dimension rule). Payload, name, description, scope, and `position` are updatable; `kind` is not. Re-scoping re-runs coherence validation and the name-uniqueness check against the **target** scope, and re-appends the item at the end of the target scope's position sequence.

**Effective-context response** (`GET /api/v1/issues/:id/context`):

```jsonc
{
  "prompt": {
    "text": "…",                    // the stitched prompt, headings included
    "parts": [ { "item_id", "name", "scope": {…ids + label}, "body" } ]  // layer order
  },
  "skills": [ { "item_id", "name", "scope": {…}, "files": [ { "path", "content" } ] } ],
  "repos":  [ { "item_id", "name", "scope": {…}, "url", "branch"?, "dir" } ],   // dir always resolved
  "overridden": [ { "item_id", "kind", "name", "scope": {…}, "overridden_by": "<item_id>" } ],
  "conflicts": [ { "kind": "repo_dir", "dir": "…", "item_ids": [ … ] } ]
}
```

Skills carry full file contents — the caps keep the payload small, and both the issue panel and `--out` need them. `overridden` lists losers of name collisions for skills and repos alike; `conflicts` reports checkout-dir collisions among the effective repos.

Skill file edits go through `PATCH /api/v1/context/:id` with the full file list (declarative replace — the item is small by construction; no per-file endpoints).

**Validation.** Unknown kinds, kind/payload mismatches, scope-coherence failures, name collisions, path violations, and cap overruns are all structured 422s in the phase-one convention: they name the violated rule and, where applicable, what is allowed. Nothing is silently dropped or coerced.

The issue read (`GET /api/v1/issues/:id`) gains a lightweight **`context_summary`**: per-kind counts of the currently effective context, **post-dedupe** (overridden items don't count). This serves the issue detail page only — issue *list* endpoints are unchanged and list rows carry no context badge in this phase (adding one later behind an include flag is easy; computing effective context per row is not free on D1 and hasn't earned its cost).

## CLI

```
tines context list [--project <name>] [--state <workflow>/<state>] [--issue <ref>] [--kind <k>] [--exact]
tines context show <id>
tines context create --kind prompt --name <n> [scope flags] --body <md|@file>
tines context create --kind skill  --name <n> [scope flags] --file <path>=@<local>...
tines context create --kind repo   --name <n> [scope flags] --url <u> [--branch <b>] [--dir <d>]
tines context edit <id> [same flags] [--unset project|state|issue] [--remove-file <path>]
tines context delete <id>
tines issues context <project>/<number> [--json] [--out <dir>] [--force]
tines issues prompt <project>/<number> [--json]
```

Conventions:

- Scope flags: `--project <name>`, `--state <workflow>/<state>` (state names are only unique per workflow, so the qualified form is required everywhere, `list` included), `--issue <project>/<number>` — combinable per the intersection rules.
- `--body` takes inline Markdown or `@file`; a literal body starting with `@` is escaped as `@@`.
- `--file <path>=@<local>` maps a workspace path to a local file's content; content always comes from a file (no inline form). Workspace paths cannot contain `=` (enforced server-side too), so the first `=` is the separator.
- `edit` uses the same flags as `create` plus `--unset` to drop a scope dimension and `--remove-file` to drop a skill file; supplying `--file` for an existing path replaces that file.

`tines issues context` is the consumption stub: it prints the stitched prompt (or the full response structure with `--json`), and `--out <dir>` writes the bundle to disk — `prompt.md` (the stitched text, headings included), `skills/<name>/<files…>`, and `repos.json` (the response's `repos` array verbatim: name, url, branch, resolved dir). `--out` refuses a non-empty directory unless `--force` is passed, and refuses entirely while the response reports `conflicts`. This is exactly the shape a launcher script or future supervisor would seed into a workspace.

`tines issues prompt` prints the launch prompt — context plus issue block — so a human can pipe or paste it, and an agent pointed at the CLI can read its own brief. Nothing else consumes context yet.

## Web UI

### Global Context tab

A fifth nav tab, **Context** (`/context`): all items in a filterable table — kind (icon + label), name, scope (compact chips using the canonical label format), updated. Filters mirror the API's; search by name. Create from here with a full scope picker, or edit any item in place. This is the only surface that lists **every** item, so it is where cross-cutting scopes are first-class rather than appearing "half" on two pages.

### In-place sections

Which scopes appear where: each element's page lists items whose scope **includes** that element, except that **issue-anchored items appear only on their issue's page** (and the Context tab) — they are that issue's business, not the project's or state's.

- **Issue detail** gains a **Context** panel with two parts:
  - **This issue's context**: items whose scope includes this issue (all four issue-anchored scope shapes), with inline create/edit — the quick path for "give this issue a note/skill/repo".
  - **Effective context** (collapsed by default): the assembled bundle — the stitched prompt rendered with a subtle source badge per part, the skill list, the repo list, overridden items struck-through with what beat them, and a warning for checkout-dir conflicts. A caption notes the current state, since transitioning changes the set; when the issue transitions, the panel updates with the same animation language as the rest of the page (entering/leaving items slide/fade, respecting `prefers-reduced-motion`). The panel shows **context only** — the issue block is not previewed here, since the rest of the page *is* the issue.
  - A **View launch prompt** action on the panel opens the full prompt (context + issue block) in a dialog: rendered and raw views, with a copy-to-clipboard button — the manual path for launching an agent by hand until the supervisor exists.
- **Project detail** gains a **Context** section: project-only items first, then `project ∧ state` items grouped under their state names (issue-anchored items excluded per the rule above). Inline create defaults the scope to this project, with an optional "only in state…" refinement.
- **Workflow detail** shows, per state, a small context indicator (count badge on the state's row/node); selecting a state reveals its non-issue-anchored items — `state`-only and `project ∧ state` (labeled with their project). Inline create defaults to that state. This is also where state removal warns about attached context and offers the forced delete with the item list.

### Item editor

One dialog/page for all kinds — kind picker up front (locked when editing), then:

- **Prompt**: name, description, Markdown editor with preview (same component as issue descriptions).
- **Skill**: name (slug-validated), description, and a small file editor — a file list (add/rename/remove paths) with a text editor per file; validation errors (bad path, size caps) inline.
- **Repo**: name, URL, branch, checkout dir (placeholder showing the derived default).

Plus the scope picker: three optional selectors (project, workflow → state, issue) rendered as removable chips, with the coherence rules enforced live (picking an issue constrains the state list to its workflow, etc.).

## Alternatives considered

- **A shared context library attached by reference** (like the workflow library). Rejected: context is expected to be written for one scope and rarely shared; a library adds a naming/management layer for little reuse. The `context_item` table stands alone, so a library (named, unscoped items + an attachment join) can be layered on later without migrating existing rows.
- **One join table per element type** (`issue_context`, `state_context`, `project_context`). Rejected: cannot express intersection scopes like the project-journal case without duplicating items, and every new dimension means a new table. Nullable scope columns give AND-composition for free.
- **Context as a single JSON document per element.** Rejected: items must be individually addressable — for override-by-name, for events, for future role filtering — and a JSON blob makes all of that opaque.
- **Skills as git-repo references or R2 bundles** instead of inline files. Deferred: inline text files in D1 need no new infrastructure and are viewable/editable in the web UI, which this phase prioritizes. The `repo` kind already covers "the real content lives in git"; R2 bundles can become a fourth kind if binaries/large assets are ever needed.
- **User-controlled global ordering** (priority across layers). Rejected for now: fixed specificity ordering plus per-scope `position` is predictable and covers the stated cases; full ordering control adds UI weight before there's evidence it's needed.
- **Repo dedup by URL.** Rejected in review: URL matching needs a normalization story (`.git`, trailing slashes) and still leaves same-URL-same-scope ties undefined. Name-based dedup is one uniform rule for every kind and makes overriding explicit — reuse the name.
- **Unlabeled prompt stitching** (raw concatenation, attribution only in structured parts). Rejected in review: the stitched text is what agents and `prompt.md` consumers actually read, and unlabeled seams make the merged prompt inscrutable. The `## Context: <scope>` heading format is deliberately part of the API surface.
- **Role filtering now.** Deferred by design: the intersection model was chosen so a role dimension is additive. Shipping a role column before agents/roles exist as entities would freeze semantics ahead of the supervisor phase.

## Acceptance criteria

Done when this loop works end-to-end:

1. Create a prompt scoped to project *Tines* ("house conventions"), a skill scoped to state *Review* (a `review-checklist` with two files), and a prompt scoped to *Tines ∧ Implementing* (the journal note).
2. An issue in *Tines* sitting in *Implementing* shows an effective context whose stitched prompt is the house prompt then the journal note, each under its `## Context: …` heading; the review skill is absent. `tines issues context tines/1` prints the same text; `--out` writes `prompt.md` and no skills.
3. Transition the issue to *Review*: the journal note leaves the effective context, the `review-checklist` skill appears, and the panel animates the change.
4. An issue in a *different* project in state *Implementing* gets neither the house prompt nor the journal note — the intersection held.
5. Attach an issue-scoped skill also named `review-checklist`: the effective view shows it overriding the state-level one (struck through, reported in `overridden`). Attach an issue-scoped repo reusing the name of a project-scoped repo but a different branch: the effective `repos` carries the issue's branch.
6. All creates/edits/deletes appear in the activity feed with correct actor attribution, including via API key; an issue-scoped item's events also appear in its project's filtered feed.
7. Deleting the *Review* state (via workflow PATCH) without `force_delete_context` is rejected with a 422 naming the attached items; retrying with the flag succeeds, reports the swept items, and emits a `context.deleted` event per item. The same posture holds for project and workflow deletion.
8. The Context tab lists every item with accurate scope chips; `GET /api/v1/context?project=Tines` returns the project's items including `project ∧ state` and `issue ∧ project` ones, and `exact=true` narrows to project-only.
9. `tines issues prompt tines/1` prints the stitched context followed by the issue block — title, description, current state, every comment with its actor, and the allowed transitions with their target states; the same text appears in the issue page's launch-prompt dialog and copies to the clipboard. Adding a comment or transitioning the issue changes the next read accordingly.

## Resolved questions

From the initial design discussion:

- **Reusable library vs. per-element**: per-element (scoped items in their own table); contexts are rarely shared. A library remains layerable later.
- **Granularity**: typed items attached directly — no container entity, no JSON blob.
- **Skill storage**: inline text files in D1, size-capped; no R2, no binaries.
- **Scoping model**: intersection (AND) of optional dimensions on the item — chosen over role tags after the journal example showed the real need is *project ∧ state* conditioning; roles become one more dimension later.
- **Web UI**: in-place sections on issue/project/workflow pages plus a global Context tab, with an effective-context preview on the issue page.

From the spec review:

- **Merge layering**: by specificity count with fixed dimension precedence — every exact scope is its own layer, so name collisions within a layer are impossible; the rule generalizes to future dimensions.
- **Deletion posture**: uniform reject-by-default; `force_delete_context` cascades all-or-nothing with per-item `context.deleted` events attributed to the deleting actor — for projects, workflows, and state removal alike.
- **List filters**: "scope includes" semantics, AND-composable, with `exact=true` for exact-scope views; no separate `scoped_to`.
- **Badging**: `context_summary` (post-dedupe per-kind counts) on the issue read only; no list badges this phase.
- **Prompt stitching**: labeled — each part under a `## Context: <scope label>` Markdown heading, blank-line separated, bodies trimmed; the format is API surface.
- **Dedup key**: item name, uniformly for skills and repos; repo URLs are never compared or normalized.
- **Unknown kinds**: strict 422s now; open-endedness is a schema-design property, not API leniency.
- **Uniqueness enforcement**: API layer only; the scope index is non-unique.
- **Launch prompt**: context items are context; the issue itself (title, description, state, comments, transitions) is appended as a generated issue block to form the full prompt an agent would run with. Exposed as `GET /api/v1/issues/:id/prompt`, `tines issues prompt`, and a copyable dialog on the issue page — kept out of the effective-context preview, which stays context-only.
