# Tines — Context Attachments Spec

> Extended by [AGENT_EDITING.md](./AGENT_EDITING.md): global (empty) scope,
> agent-maintained journals (append + version CAS), and the reviewed
> proposal path for broad context edits.

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
- **Inheritance beyond states**: inheritance ships on the **state** dimension only (Tines/238). Projects are still flat; when nesting lands (Tines/185) the project dimension applies the same rule stated below, unchanged. **Item-to-item inheritance** — one item extending another regardless of scope — is the reserved path for sharing between unrelated projects and is deliberately not built.

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
| `label_id` | issue label | applies only to issues carrying this label |
| `issue_id` | issue | applies only to this issue |

**At least one dimension must be set.** An item applies to an issue when **all** of its set dimensions match (logical AND). Examples:

- `project=Tines` — house conventions for every issue in the project.
- `state=Review` — a review checklist for any issue sitting in that state, in any project whose workflow includes it.
- `project=Tines ∧ state=Implementing` — the implementer's journal for this project: private notes on how to build features *here*, invisible to other projects and to other stages of work.
- `label=design` — a component-testing skill for design work, in any project.
- `project=Tines ∧ label=docs` — a docs-audit checklist for this project's documentation issues only.
- `issue=Tines/42` — context for one issue; optionally `issue=Tines/42 ∧ state=Review` for one issue only while in review.

This is why scope is columns on the item rather than a join table per element: the journal case is a single row with two dimensions set, and the **label** dimension added in Tines/168 was one more nullable column with the same AND semantics — no schema restructuring.

**Labels are set-valued, and that is new.** Project, state and issue each hold exactly one value for a given issue; an issue carries a *set* of labels. The AND rule is unchanged (a label dimension matches when the issue carries that label), but two consequences below are specific to it: same-rank layers are no longer impossible, and the layer order had to say where a label sits rather than inherit it from a dimension count. Single-element attachment is just the one-dimension degenerate case, which the UI presents as "attach context to this issue/state/project".

**Scope display label.** Wherever a scope is rendered as text — UI badges, stitched-prompt headings, event payloads — it uses one canonical format: set dimensions in the order project · state · label · issue, joined with `·`, each as `<dimension> <display name>` (issues as `<project>/<number>`). E.g. `project Tines · state Review`, `project Tines · label design`.

**Coherence validation** (422 on violation):

- `issue_id` and `project_id` both set → the issue must belong to that project (the UI omits the redundant combination; the API tolerates it when coherent).
- `issue_id` and `workflow_state_id` both set → the state must belong to the issue's bound workflow. Inheritance does not relax this: an item scoped to an issue *and* to an **ancestor** of that issue's state is incoherent (the base is not in the issue's workflow) and 422s. Scope one to the base state alone, or to the issue alone.
- All referenced elements must belong to the authenticated user (states may also come from the system standard workflow).

`project ∧ state` combinations are *not* checked against the project's default workflow — issues choose workflows per issue, so any of the user's states may pair with any project. The UI surfaces a gentle hint when the pairing can never currently match (no issue in that project uses that state's workflow), but it is not an error.

### Effective context for an issue

The assembled bundle for issue *I* in project *P*, currently in state *S*: every item whose set dimensions all match *(P, S, I)*, organized as follows.

**Layer order — by specificity, broad → specific.** Matching items are grouped by their exact scope tuple, and scopes order by a **fixed weight per dimension**, summed: `project=1`, `state=2`, `label=4`, `issue=8`. Lower total sorts first. Read as a rule: each dimension outranks every combination of the dimensions below it, so a scope naming a more specific dimension always sorts later regardless of how many dimensions the other names.

The 15 possible scopes therefore order:

| Rank | Scope | | Rank | Scope |
| --- | --- | --- | --- | --- |
| 1 | `project` | | 9 | `issue ∧ project` |
| 2 | `state` | | 10 | `issue ∧ state` |
| 3 | `project ∧ state` | | 11 | `issue ∧ project ∧ state` |
| 4 | `label` | | 12 | `issue ∧ label` |
| 5 | `label ∧ project` | | 13 | `issue ∧ label ∧ project` |
| 6 | `label ∧ state` | | 14 | `issue ∧ label ∧ state` |
| 7 | `label ∧ project ∧ state` | | 15 | `issue ∧ label ∧ project ∧ state` |
| 8 | `issue` | | | |

Label sits directly under `issue`: *a label is a per-issue classification, so it outranks the ambient dimensions — which project this is, which stage it is at — but not the issue itself.* This placement is a **prefix extension**: the seven scopes that existed before labels (ranks 1–3 and 8–11) keep their relative order exactly, so no shipped item changed layer when the dimension landed.

An earlier wording ordered layers by **number of dimensions set**, tie-broken by precedence. That was never what the code did — it has always summed bit weights — and the two disagree once a dimension can be skipped (`label ∧ project ∧ state` sets three dimensions but sorts before the one-dimension `issue`). The weight rule is the real one, and it is what generalizes: a future dimension picks a weight and slots in.

Within a layer, items order by `position`, then `created_at`, then `id` (timestamps are ms integers and can tie).

**Same-rank layers, and why they exist.** Names are unique per exact scope, so for the single-valued dimensions every exact scope is its own layer and within-layer collisions are impossible by construction. Labels break that: an issue carrying both `design` and `qa` matches a `label design` layer *and* a `label qa` layer, which have the same rank, and each may hold a skill named `component-testing`. Such layers are ordered **by label name** (case-insensitively, then by label id), which is deterministic, needs no schema, and is visible — the losing item appears in `overridden`, and both `## Context: … · label …` headings are in the prompt. It is arbitrary in the sense that `design` beating `qa` carries no meaning; a `label.position` priority column is the principled upgrade if that ever matters. The rationale for the order: general house rules first, then what-this-stage-of-work means, then what kind of work this is, then refinements — each layer reads as a refinement of the previous. The rule is generative, not enumerated: a future role dimension slots in by picking a weight, without re-deciding anything.

**Inheritable dimensions.** A dimension may be **inheritable**: its values form a forest — one parent each, chains of at most 3 values, no cycles, all four refused with a readable 422. An item matches an issue when the issue's value for that dimension **or any of its ancestors** equals the item's; the AND across dimensions is unchanged, and so is every rank in the table above. Ancestors stitch **before** their descendants (root → leaf), as a **tie-break inside the existing rank**, applied in ascending dimension weight: `project ∧ base` still ranks with `project ∧ state` (rank 3), before any label or issue layer, and ancestor depth only decides among rows of equal rank — ahead of the label-name tie-break, because state's weight (2) is below label's (4). An inherited layer renders the **qualified** label `state <workflow> / <state>` so two same-named states cannot collide under one `## Context: state X` heading, and the effective-context API marks its parts, skills, repos and `overridden` entries with `inherited_from` (the base state's id, name, workflow id and workflow name; `null` otherwise). A parentless value therefore resolves byte-identically to how it did before inheritance existed.

**State inheritance.** The pointer is `workflow_state.inherits_from_state_id`, settable as `inherits_from` on `WorkflowStateInput` in workflow create and edit. On an **existing** state the field is merge-patch: absent = unchanged, `null` = clear, a string = set — so the many callers that round-trip states as `{id, name, category}` cannot silently wipe a pointer. The base may live in another workflow or in the standard workflow (which can be a base, never a child). The convention for a shared base is a workflow with **no transitions** whose states are categorized `backlog`: legal as an initial state, undispatchable by the supervisor, so no `template` flag is needed.

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

*(chronological; "No comments yet." when empty. The section ends with:
Add a comment: `tines issues comment <project>/<number> "<markdown>"`)*

### Available transitions

- **<action name>** → <target state name> (<category>): `tines issues move <project>/<number> "<action name>"`
```

Each transition carries its runnable CLI command (action name quoted, so multi-word actions like "send back" paste correctly), and the comments section header notes `tines issues comment <project>/<number> "<markdown>"` as the way to add one — so an agent holding only this prompt and a `TINES_API_KEY` knows its legal moves *and* how to make them.

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
- **Deleting a label** (`DELETE /api/v1/labels/:id`) follows the same rule: rejected with a 422 (`label_in_use`) naming the context items *and* the routing rules scoped to it, and accepting **`force: true`** in the body, which deletes them with the label. A label-scoped routing rule is **deleted, never label-stripped** — stripping would silently broaden `label docs ∧ project X` into `project X`, which is a live rule doing something nobody asked for. (The flag is `force`, not `force_delete_context`, because it sweeps rules as well as context.)
- **Removing a state, or deleting a workflow, that other states inherit from** is rejected with a 422 (`state_inherited` / `workflow_inherited`) naming the children as `<workflow> / <state>`. **`force_clear_inheritance: true`** clears the children's pointers in the same transaction and reports them (`cleared_inheritance` on the response, `inheritance_changed` on the event). This is a **separate flag from `force_delete_context`** on purpose: consenting to sweep your own context is not consent to change another workflow's prompts.
- **Pointing a state at a base the same request removes** is rejected with a 422 (`inheritance_target_removed`) naming the base. The target is still stored when the write is validated, so without this check the request would reach the batch and fail on the foreign key as an unhandled error — the one refusal in this feature that would not be readable. Keeping an *existing* pointer onto a removed state is the `state_inherited` case above, not this one.
- **Issues** cannot be deleted in phase one, so issue-scoped items have no orphan path.
- An item whose scope references a force-deleted anchor is deleted entirely, even if its other dimensions survive (there is no "partially scoped" leftover).

The workflow editor shows which states carry context, and the UI confirmation dialogs list what a forced delete will sweep.

## Data model (D1 / Kysely)

```
context_item        id, user_id, kind, name, description?,
                    project_id?, workflow_state_id?, label_id?,
                    issue_id?,                                      -- scope; all-null = global
                    body?,                                          -- prompt: markdown
                    repo_url?, repo_branch?, repo_dir?,             -- repo pointer
                    position, created_at, updated_at
context_item_file   id, context_item_id, path, content, created_at, updated_at
                    -- skill files; unique on (context_item_id, path)
```

Notes:

- Kind-specific payloads live as nullable columns (`body` for prompts, `repo_*` for repos) plus the child file table for skills. A future kind with a structured payload can use a JSON `config` column added at that time; the row shape above deliberately leaves room rather than pre-adding it.
- A **non-unique** index on `(user_id, project_id, workflow_state_id, issue_id)` supports the matching and listing queries, and a second on `label_id`. Name-uniqueness per (kind, exact scope) is checked in the API layer so the common case returns a structured 422 rather than a raw constraint error, and is **also** enforced by a unique index over the scope columns wrapped in `COALESCE(<col>, '')` (`context_item_name_scope_uq`, added in `0007`) — `COALESCE` is what expresses partial-NULL uniqueness in SQLite, which the original design thought impossible. The API check is the message; the index is the backstop. Adding a scope dimension therefore means rebuilding that index, not only widening the API check.
- The ≥1-dimension `CHECK` the original design called for was dropped when `0006` rebuilt the table; an all-null scope is a **global** item (`agent-guidelines` is one), which the UI names and offers directly. The constraint is not re-added.
- `label_id` (Tines/168) is the fourth scope dimension and the first **set-valued** one — it matches through `issue_label`, so the clause is `label_id IS NULL OR EXISTS (issue_label …)` rather than a column comparison. It arrived exactly as this section predicted for `role`: one nullable column and one more AND clause. No `role` column yet; the same recipe applies.
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

**List filter semantics — "scope includes".** `project=X` matches every item whose scope includes project X (project-only, `project ∧ state`, `issue ∧ project`, …); likewise `state=`, `label=` (by label id or name) and `issue=`. Multiple dimension filters AND together. Adding **`exact=true`** restricts to items whose scope sets *only* the given dimensions — the editor's "items scoped exactly here" views. There is no separate `scoped_to` parameter.

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
tines context create --kind repo   --name <n> [scope flags] --repo-url <u> [--branch <b>] [--dir <d>]
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

A nav tab, **Context** (`/context`): under All projects it lists all items; under a project focus it lists items anchored directly on that project or on one of its issues, plus the count of global and state-scoped library items that also apply. Kind, workflow, label and search filters remain; project scope comes from focus. Create defaults to the focus while the full scope picker remains available. The HTTP API's explicit `project` filter retains its narrower direct-project semantics; the project-touching rule is web presentation only. Legacy `?project=<id|name>` links set focus once and redirect, while ordinary project-page links use plain `/context` so link preloading cannot mutate focus.

### In-place sections

Which scopes appear where: each element's page lists items whose scope **includes** that element, except that **issue-anchored items appear only on their issue's page** (and the Context tab) — they are that issue's business, not the project's or state's.

- **Issue detail** gains a **Context** panel with two parts:
  - **This issue's context**: items whose scope includes this issue (all four issue-anchored scope shapes), with inline create/edit — the quick path for "give this issue a note/skill/repo".
  - **Effective context** (collapsed by default): the assembled bundle — the stitched prompt rendered with a subtle source badge per part, the skill list, the repo list, overridden items struck-through with what beat them, and a warning for checkout-dir conflicts. A caption notes the current state, since transitioning changes the set; when the issue transitions, the panel updates with the same animation language as the rest of the page (entering/leaving items slide/fade, respecting `prefers-reduced-motion`). The panel shows **context only** — the issue block is not previewed here, since the rest of the page *is* the issue.
  - A **View launch prompt** action on the panel opens the full prompt (context + issue block) in a dialog: rendered and raw views, with a copy-to-clipboard button — the manual path for launching an agent by hand until the supervisor exists.
- **Project detail** gains a **Context** section: project-only items first, then `project ∧ state` items grouped under their state names (issue-anchored items excluded per the rule above). Inline create defaults the scope to this project, with an optional "only in state…" refinement.
  - *Revised 2026-09 (Tines/146, Tines/260):* the `project ∧ state` items are collapsed into one accordion row per workflow (closed by default, single-select, workflows alphabetical, states in workflow position order, one `{n} states · {m} items` chip) beneath the still-expanded project-only list, and the whole section moves below Issues, Scheduled tasks and Agent routing. `View all in Context` opens plain `/context`; opening the project page already sets focus.
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
9. `tines issues prompt tines/1` prints the stitched context followed by the issue block — title, description, current state, every comment with its actor, and the allowed transitions each with its runnable `tines issues move` command (multi-word actions quoted); the same text appears in the issue page's launch-prompt dialog and copies to the clipboard. Adding a comment or transitioning the issue changes the next read accordingly, and pasting a transition's command from the prompt performs that transition.

## Resolved questions

From the initial design discussion:

- **Reusable library vs. per-element**: per-element (scoped items in their own table); contexts are rarely shared. A library remains layerable later.
- **Granularity**: typed items attached directly — no container entity, no JSON blob.
- **Skill storage**: inline text files in D1, size-capped; no R2, no binaries.
- **Scoping model**: intersection (AND) of optional dimensions on the item — chosen over role tags after the journal example showed the real need is *project ∧ state* conditioning; roles become one more dimension later.
- **Web UI**: in-place sections on issue/project/workflow pages plus a global Context tab, with an effective-context preview on the issue page.

From the spec review:

- **Merge layering**: by summed per-dimension weight (`project=1`, `state=2`, `label=4`, `issue=8`), broad → specific; the rule generalizes to future dimensions, which pick a weight.
- **Label as the fourth dimension** (Tines/168): weight 4, directly under `issue` — a per-issue classification outranks the ambient dimensions but not the issue. Chosen as a prefix extension so no shipped layer changed rank.
- **Same-rank label layers**: ordered by label name, case-insensitively. Deterministic and visible in `overridden`; chosen over `created_at` (today's accidental behaviour — invisible and surprising) and over a `label.position` column, which is the upgrade path if the arbitrariness bites.
- **Deletion posture**: uniform reject-by-default; `force_delete_context` cascades all-or-nothing with per-item `context.deleted` events attributed to the deleting actor — for projects, workflows, and state removal alike.
- **List filters**: "scope includes" semantics, AND-composable, with `exact=true` for exact-scope views; no separate `scoped_to`.
- **Badging**: `context_summary` (post-dedupe per-kind counts) on the issue read only; no list badges this phase.
- **Prompt stitching**: labeled — each part under a `## Context: <scope label>` Markdown heading, blank-line separated, bodies trimmed; the format is API surface.
- **Dedup key**: item name, uniformly for skills and repos; repo URLs are never compared or normalized.
- **Unknown kinds**: strict 422s now; open-endedness is a schema-design property, not API leniency.
- **Uniqueness enforcement**: checked in the API layer for the error message, backstopped by a `COALESCE`-wrapped unique index over the scope columns since `0007`.
- **Launch prompt**: context items are context; the issue itself (title, description, state, comments, transitions) is appended as a generated issue block to form the full prompt an agent would run with. Exposed as `GET /api/v1/issues/:id/prompt`, `tines issues prompt`, and a copyable dialog on the issue page — kept out of the effective-context preview, which stays context-only. The issue block includes the runnable CLI commands for each available transition and for commenting, so the prompt alone tells an agent how to act, not just what its options are.

From later work:

- **2026-09-01, Tines/92 — repo clone URL is `--repo-url`, not `--url`**: `-u, --url` is the API base URL on every CLI command without exception. The repo kind originally took `--url` for the clone URL and suppressed the base-URL flag, which left `context create` unable to target a non-default deployment except via `TINES_API_URL`. Payload flags that happen to hold a URL are named for what they hold.
