# Tines — Agent-Maintained Context Spec

Extends [SPEC.md](./SPEC.md) (context attachments). That spec made context a
thing humans write and agents read. This one closes the loop: agents should
leave the workspace smarter than they found it — appending lessons to a
shared **journal**, correcting entries that turned out wrong, and proposing
changes to broader context — without being able to silently rewrite the
rules everyone else runs under.

The design reuses what already exists rather than adding machinery: the
approval workflow for broad edits **is** the issue system; the instructions
that teach agents all of this **are** a context item; and the only new write
primitives are an append and a compare-and-swap. Its central bias is
**affordance asymmetry**: the launch prompt hands the agent a ready-made
handle for its journal and for nothing else — the right path is the easy
path, and every broader edit requires deliberate extra steps.

## Goals

- A **global scope** — the empty scope — whose items stitch into *every*
  launch prompt, first. This is where per-workspace agent guidance lives.
- Make the launch prompt self-sufficient for the writes an agent *should*
  make: journal appends and corrections are copy-pasteable from the prompt,
  addressed by the issue reference the agent already holds — no item ids
  appear in the prompt at all.
- Safe concurrent writing: an atomic **append** for the common case (a new
  journal entry) and version-checked **rewrite** for corrections and
  consolidation.
- A reviewed path for broad edits: agents *propose* changes to project-,
  state-, and global-scoped context by filing an issue; a human (later, a
  curator agent) applies or rejects it.
- A canonical **starter guidance** text that explains the tiers to agents,
  seeded as an ordinary, fully editable global item.

## Non-goals

- **History**: `version` is a monotonic write counter for optimistic
  concurrency, not versioning. No snapshots, no diffs beyond the existing
  `context.updated` event summaries. (Unchanged from the parent spec.)
- **Entry-level journal structure**: a journal stays one Markdown prompt
  body. Entries are dated bullets by convention, not rows; correcting one
  is a body rewrite, not an entry mutation.
- **Full enforcement of the tier etiquette**: API keys can still write any
  of the user's items through the generic context endpoints — the prompt
  simply never volunteers the handles, and broad-tier changes are routed
  to proposals by guidance. Per-key write scopes and hard ACLs are
  supervisor-phase work, as is auto-applying an approved proposal. (A
  lighter session-based guardrail is an open question below.)
- **Issue types as a schema feature**: proposal issues are recognized by
  convention (title prefix), not a `type` column. A structured, machine-
  applyable proposal payload is deferred until a curator agent exists to
  consume it.
- **A per-item `agent_editable` flag**: humans marking arbitrary items as
  agent-maintained generalizes the journal, but there is no second use
  case yet; the named-journal convention carries this phase.

## Concepts

### Global scope: the empty intersection

The parent spec required at least one scope dimension. That requirement is
lifted: an item with **no** dimensions set is **global** and matches every
issue. Everything else falls out of existing rules:

- **Layer order**: the specificity rank already reads the scope as a binary
  number over (issue, state, project); the empty scope is rank **0** and
  stitches before everything — general first, specific last, unchanged.
- **Label**: the canonical scope label for the empty scope is `global`
  (UI chips, stitched headings — `## Context: global` — event payloads).
- **Uniqueness**: names remain unique per (kind, exact scope); the empty
  scope is one more exact scope.
- **List semantics**: unchanged — `exact=true` with no dimension filters
  already means "all dimensions unset", i.e. global items only.
- **Events**: global items carry no issue/project references, like
  state-only items; their events appear only in the global feed.
- **Lifecycle**: global items are anchored to nothing, so no deletion
  guard applies to them.
- **Editor**: the scope picker treats "nothing selected" as a valid choice,
  summarized as "Global — applies to every launch prompt" (replacing the
  current pick-at-least-one requirement).

### Writing tiers: who inherits the note

Prose about the issue at hand — progress, findings, dead ends, questions,
handoff instructions — is **comments**, full stop. Comments already reach
every future launch prompt for that issue, chronologically and attributed;
splitting "progress" from "instructions" was a distinction without a
difference. Issue-scoped context items are therefore **artifact slots**:
things attached rather than said — a skill the issue needs, a repo/branch
pin, or a same-name override of a broader item. Not notes. Attachment is
name-addressed (`tines context create … --issue <ref>`), so it needs no
ids either.

The **journal** is, by convention, the prompt item named `journal` scoped
to `project ∧ state`: lessons that help anyone doing this stage of work in
this project. Agents append freely and correct freely — the blast radius is
one project-stage, and the journal is precisely the consolidation target
the parent spec's journal example anticipated.

**Journal heading.** In the stitched prompt, the journal's part renders
under `## Journal (<scope label>)` — e.g.
`## Journal (project Tines · state Implementing)` — instead of the generic
`## Context: <scope label>`. The rule keys on the same predicate as the
command family (prompt named `journal` at exactly `project ∧ state`), so
the agent sees "Journal" directly above the entries it maintains and the
prompt-final section can reference it by name. This is display-only: the
canonical scope label is unchanged everywhere else (UI chips, events,
`parts[].scope.label`, proposal references), and a non-journal prompt in
the same layer keeps the ordinary heading.

**Broader tiers are propose-only for agents.** Project-, state-, and
global-scoped context governs work the proposing agent cannot see, so
changes route through review (below) instead of direct writes.

A future role dimension slots into the same rule unchanged: write to the
narrowest scope shared by everyone who should inherit the note.

### Version counter and compare-and-swap

`context_item` gains `version` (integer, starts at 1, incremented by every
successful content write: PATCH that changes anything, append, file-set
replacement). `version` is returned wherever the item is serialized —
list rows, detail reads, and each entry in the effective-context response.

`PATCH /api/v1/context/:id` and the append call accept an optional
**`expected_version`**. On mismatch the write is rejected with a **409**
whose body carries the current item (version included) so the caller can
rebase and retry. Omitting `expected_version` keeps today's last-write-wins
behavior. A timestamp CAS was rejected: `updated_at` has millisecond
resolution and two writes can share it.

### Append

```
POST /api/v1/context/:id/append   { "text": "…", "expected_version"?: n }
```

Prompt items only (422 otherwise). Appends the trimmed text to the body,
separated by exactly one blank line, server-side and atomically — two
concurrent appends both land, in some order, and an append never clobbers
a concurrent rewrite (nor vice versa; rewrites use `expected_version`).
The 32 KB body cap applies to the result. Bumps `version` and `updated_at`
and emits `context.updated` with `appended: true` in the payload alongside
the usual summary. Returns the updated item.

Correcting or pruning an entry is not a special operation: read the body,
revise it, and PATCH the full body with `expected_version`. The same
motion serves consolidation, which the guidance encourages: rewrite, don't
only append.

### The journal command family: no ids in the prompt

Agents address their journal by the one reference they already hold — the
issue — never by item id:

```
tines journal show    [--state <workflow>/<state>] <project>/<number> [--json]
tines journal append  [--state <workflow>/<state>] <project>/<number> <markdown>
tines journal rewrite [--state <workflow>/<state>] <project>/<number> --body <md|@file> --expect-version <n>
```

The CLI asks `GET /api/v1/issues/:id/journal` which scope it owns, and
targets the prompt item named `journal` at exactly that scope
(`project ∧ state`). `append` finds-or-creates it: if absent, the item is
created with the text as its first body (on a create race, the loser
retries as an append). `show` prints the body and version; `rewrite` is
the version-checked whole-body replace.

The scope is the state the caller's **run was launched in**
(`agent_run.state_id_at_start`, reached from the run key via
`api_key.agent_run_id`) — not the issue's current state. A run's identity
is its stage: the lessons it learns belong to the stage that did the work,
and the launch prompt tells agents to move the issue last, so resolving
against the current state silently misfiled every lesson appended after a
transition. Callers that are not a run — a browser session, a named PAT,
or a run key presented against a different issue — get the issue's current
state, as does a run whose launch state a workflow edit has since deleted;
in the latter two cases the response carries a `note` saying so, and the
CLI prints it to stderr. Resolution never fails on an anchor problem: a
lost lesson is worse than a misfiled one.

`--state <workflow>/<state>` overrides the resolution entirely — the
recovery tool for a lesson already filed in the wrong journal, and the way
a curator reads another stage's journal. Note the argument order: `append`
is `passThroughOptions()` (so a lesson may itself start with `-`), which
makes a *trailing* `--state` a hard parse error rather than a silent
no-op; the flag goes before `<ref>`, and the help text says so.

Apart from that one read endpoint, these are CLI sugar over the generic
endpoints (exact-scope list + create / append / PATCH); JSON-only agents
do the same dance. Writes stay on the generic context endpoints.

The asymmetry is the point: the journal is reachable in one id-free,
copy-pasteable command, while directly editing any broader item requires
deliberately going through `tines context list` to discover an id the
prompt never volunteered. Proposals (below) need no ids either — they
reference items by kind, name, and scope label.

### Context update proposals

To change project-, state-, or global-scoped context, an agent files an
ordinary issue — **in the project it is working in** — titled
`Context change: <scope label>`, whose description names the target item
(kind, name, scope; or proposes a new one) and contains the **full
proposed text**, not a delta. The human reviews it like any issue: discuss
in comments, apply the change through the normal context editor or CLI,
and close the issue; or close it rejected. Everything rides on existing
rails — comments for discussion, `awaiting_human` states for the review
gate, events for the audit trail.

Deliberate choices:

- **Same project, not a meta project**: every agent has a project in hand,
  and the proposal surfaces in that project's feed where its humans look.
  Teams that prefer a central "Ops" board redirect proposals by editing one
  line of the guidance text — the convention lives in context, not code.
- **Convention over schema**: no `type` column, no proposal entity. When a
  curator agent arrives (supervisor phase), a structured payload can be
  added so approval applies mechanically; the title convention is
  forward-compatible with that.
- **Recursion is a feature**: state-scoped context on the review state of
  whatever workflow proposals use is the natural place to instruct the
  future curator agent how to judge them.

### Launch prompt: the `### Journal` section

The generated issue block stays purely factual, and gains two things after
`### Available transitions` — a prominent journal section and a names-only
footnote for everything else. No item ids appear anywhere in the prompt.

With a journal present (its body already stitched above as a context
layer):

```markdown
### Journal

Your journal for this project and stage is the "Journal" section above
(currently v7).

Appends land in this stage's journal even after you move the issue.

- Append a lesson: `tines journal append Tines/1 "- <date>: <lesson>"`
- Fix or prune entries: `tines journal show Tines/1 --json`, revise, then
  `tines journal rewrite Tines/1 --body @file --expect-version 7`
```

Without one:

```markdown
### Journal

No journal exists yet for project Tines · state Implementing. Start one:
`tines journal append Tines/1 "- <date>: <lesson>"`
```

Then two factual footnote lines, each present only when non-empty:

```markdown
Attached to this issue: skill "csv-tools" (2 files), repo "tines-src"
(branch csv-export). Fetch them: `tines issues context Tines/12 --out <dir>`

Also in effect: prompt "agent-guidelines" (global), prompt
"house-conventions" (project Tines). These are shared — to change one,
file an issue titled `Context change: <scope label>`.
```

The first line names this issue's effective artifacts (skills and repos,
post-dedupe) with the existing bundle-fetch command — the agent's own
attachments are fair game, so they get their command. The second lists the
other effective prompt items by kind, name, and scope label only; its sole
affordance is the proposal convention.

The section ends the prompt-final issue block, so the journal affordance
sits where recency favors it. Which tier to use *when* is not stated here;
that is guidance, and guidance is a context item (below). Like the rest of
the issue block, this is read-time formatting: no events, always current.

### Seeding context at creation time

The best moment to write a project's conventions or a state's instructions
is the moment the project or state is created — so the creation surfaces
nudge for an initial prompt. The nudge lives in the **clients**; the API
stays neutral (agents and scripts create projects too, and a required
field would only harvest empty strings). The API's role is atomicity:

- `CreateProjectRequest` gains optional **`initial_prompt`** (Markdown).
  When present, the create also inserts a project-scoped prompt item named
  **`conventions`** in the same transaction, emitting both `project.created`
  and `context.created`.
- `WorkflowStateInput` gains optional **`prompt`** (Markdown), valid only
  on **new** states (no `id`). Each such state gets a state-scoped prompt
  item named **`instructions`** in the same batch as the state itself.
  `prompt` on an existing state is a 422 — stage instructions are edited
  through the context surfaces, not re-sent through workflow updates.

Both default names are convention, not magic: the created items are
ordinary — renameable, deletable, and (`journal` aside) carrying no
special rendering. Because the project or state is newly created, its
exact scope is empty by construction, so the default names cannot collide.

**CLI — hard nudge.** `tines projects create <name>` fails unless exactly
one of `--prompt <md|@file>` or `--no-prompt` is given; the error teaches
("every issue in a project inherits its context — pass --prompt, or
--no-prompt to create without one; add context later with `tines context
create -k prompt -p <name> …`"). In workflow definitions, each state
object accepts an optional `"prompt"` key; `workflows create` and
`workflows edit` fail when any *new* state lacks one, naming the
promptless states, unless `--no-prompts` is passed. `--no-prompt(s)`
follows the CLI's existing `--no-*` convention.

**Web UI — soft nudge.** The new-project modal gains an optional "House
conventions" textarea ("stitched into the prompt of every agent working
in this project"); the workflow editor gains a collapsed "＋ Add stage
instructions" textarea on each new state row. No hard requirement in the
UI — the empty field is a visible, conscious choice there, whereas CLI
creations are scripted and agent-driven, where forgetting is systematic
and a flag is cheap. That asymmetry is deliberate.

### Starter guidance: the seeded `agent-guidelines` item

The etiquette itself ships as a global **prompt** item named
`agent-guidelines` — ordinary, editable, deletable. It is created
automatically for new users at signup; existing users get a one-click
"Add starter agent guidance" affordance on the Context tab (and
`tines context init`), which is a no-op if an item with that name already
exists at global scope. Tines never overwrites it: after seeding, the text
is entirely the user's.

The canonical starter text (kept in the codebase as the seed constant):

```markdown
You are an agent working on a Tines issue over its HTTP API / CLI. Beyond
doing the work, leave the workspace smarter than you found it. Four places
to write, chosen by who should inherit what you learned:

- **Issue comments** — all prose about this issue: progress, findings,
  dead ends, questions, and instructions for whoever picks it up next.
  `tines issues comment <project>/<number> "<markdown>"`
- **Issue context (artifacts)** — things this issue needs *attached*, not
  said: a skill, a repo/branch pin, or an override of a broader item
  (reuse its name): `tines context create --kind <k> --name <n> --issue
  <project>/<number> …`. Never notes — notes are comments.
- **Your journal** — shared notes for anyone doing this stage of work in
  this project. Append a dated bullet whenever you learn something they
  would want: commands that actually work, gotchas, where things live
  (see "Journal" at the end of this prompt for the exact commands). If an
  entry is wrong or stale, rewrite the journal to fix it — do not append
  a correction on top. Keep it short; prune when you touch it.
- **Context change requests** — never edit shared context (project-,
  state-, or global-scoped items) directly. Propose instead: file an
  issue in the project you are working in, titled
  `Context change: <scope label>`, naming the item (kind, name, scope)
  with the full proposed text in the description. A human reviews and
  applies it.

When in doubt: comment. If the lesson outlives this issue, journal it.
Only file a context change when a shared rule is wrong or missing.
```

### Example launch prompt

For `Tines/12` sitting in *Implementing*, with the starter guidance, a
house prompt, a journal, an issue-scoped constraint prompt, and two issue
artifacts in place, `tines issues prompt Tines/12` yields:

```markdown
## Context: global

You are an agent working on a Tines issue over its HTTP API / CLI. …
[the agent-guidelines body above]

## Context: project Tines

House conventions: pnpm monorepo, Node >= 20. Use tabs. Run `pnpm check`
and `pnpm test` before declaring anything done. Write terse commit
messages; prefer small PRs.

## Journal (project Tines · state Implementing)

- 2026-08-18: `pnpm db:migrate:local` must run before the e2e suite; a
  missing migration surfaces as a cryptic D1_ERROR, not a clear failure.
- 2026-08-20: the D1 batch API is the only transaction primitive — build
  multi-statement writes as CompiledQuery lists for `runAtomic`.
- 2026-08-22: svelte-check flags unused `$derived` — delete, don't
  underscore-prefix.

## Context: issue Tines/12

Constraints from product: the export must stream — never buffer the full
result set in the worker. Column set is exactly the list view's columns;
no custom column picker in v1.

## Issue: Tines/12 — Add CSV export to the issues list

Add a CSV export to the issues list: a download button in the web UI and
`--csv` on `tines issues list`, both backed by one endpoint that honors
the existing list filters.

### Current state

Implementing (active), in workflow "Feature".

### Comments

**Tom** (2026-08-23T18:04:11.000Z):
Scoped this down for v1 — see the constraints attached to this issue.

**Tom via supervisor-key** (2026-08-24T09:15:42.000Z):
Endpoint skeleton is up and the filter flags pass through. Streaming is
still TODO; the naive version buffers. Handing off.

Add a comment: `tines issues comment Tines/12 "<markdown>"`

### Available transitions

- **submit** → Review (awaiting_human): `tines issues move Tines/12 "submit"`

### Journal

Your journal for this project and stage is the "Journal" section above
(currently v7).

Appends land in this stage's journal even after you move the issue.

- Append a lesson: `tines journal append Tines/12 "- <date>: <lesson>"`
- Fix or prune entries: `tines journal show Tines/12 --json`, revise, then
  `tines journal rewrite Tines/12 --body @file --expect-version 7`

Attached to this issue: skill "csv-tools" (2 files), repo "tines-src"
(branch csv-export). Fetch them: `tines issues context Tines/12 --out <dir>`

Also in effect: prompt "agent-guidelines" (global), prompt
"house-conventions" (project Tines). These are shared — to change one,
file an issue titled `Context change: <scope label>`.
```

Reading top to bottom: layers in rank order (global 0 → project 1 →
project ∧ state 3 → issue 4), each a refinement of the last, the task
nearest the end. The issue-scoped prompt shows that tier's job under the
etiquette — a durable, human-attached constraint, while the handoff
chatter stays in comments. The guidance explains *when*; the Journal
section supplies the *how* for the one write the agent should make
routinely — and nothing in the prompt hands it a handle for anything
broader. An agent holding only this text can journal, correct the
journal, attach artifacts, and file a `Context change:` proposal.

## Data model changes

```
context_item   + version INTEGER NOT NULL DEFAULT 1
               - CHECK (≥1 scope dimension)          -- empty scope = global
```

SQLite cannot drop a CHECK in place; the migration rebuilds the table
(create-copy-rename) adding `version` in the same pass. No other tables
change.

## API

| Change | Detail |
| --- | --- |
| `POST /api/v1/context` | Scope may be empty (global). |
| `POST /api/v1/projects` | Optional `initial_prompt` → project + its `conventions` prompt item, atomically. |
| `POST/PATCH /api/v1/workflows*` | Optional `prompt` per **new** state → the state + its `instructions` prompt item, atomically; 422 on existing states. |
| `PATCH /api/v1/context/:id` | Accepts `expected_version`; 409 with the current item on mismatch. Unsetting the last scope dimension now yields a global item instead of a 422. |
| `POST /api/v1/context/:id/append` | New. `{ text, expected_version? }`; prompts only; atomic; cap-checked; returns the updated item. |
| everywhere items serialize | `version` included (list rows, detail, effective-context entries). |
| `GET /api/v1/issues/:id/prompt` | Issue block gains the `### Journal` section and the names-only shared-context footnote. |
| `GET /api/v1/issues/:id/journal` | New. Read-only; resolves which journal the caller owns — `{ scope, anchor: 'run' \| 'current', note, item }`, run-anchored for run keys. |

## CLI

```
tines journal show    [--state <workflow>/<state>] <project>/<number> [--json]
tines journal append  [--state <workflow>/<state>] <project>/<number> <markdown>
tines journal rewrite [--state <workflow>/<state>] <project>/<number> --body <md|@file> --expect-version <n>
tines context edit <id> … --expect-version <n>
tines context create …                       # scope flags now optional → global
tines context init                           # seed agent-guidelines if absent
tines projects create <name> --prompt <md|@file> | --no-prompt
tines workflows create/edit …                # states carry "prompt"; --no-prompts to decline
```

`context list` renders global items with scope `global`; everything else is
unchanged.

## Web UI

- Scope picker: empty selection is valid, summarized as "Global — applies
  to every launch prompt"; `global` chips in lists and the Context tab.
- Context tab: "Add starter agent guidance" affordance when no global
  `agent-guidelines` exists.
- New-project modal: optional "House conventions" textarea (feeds
  `initial_prompt`); workflow editor: collapsed "＋ Add stage
  instructions" textarea on each new state row (feeds the state's
  `prompt`).
- Conflict handling: the editor sends `expected_version` from the item it
  loaded and surfaces the 409 as "changed since you opened it — reload".

## Future improvements

- **Session-only broad writes** — decided: **deferred**. The actor model
  already distinguishes browser sessions from API keys, so an optional
  guardrail is cheap when wanted: API-key writes to project-, state-, or
  global-scoped items refused (403 pointing at the proposal convention)
  unless the request passes an explicit `allow_broad: true` (CLI
  `--broad`). For now the bet is that the affordance asymmetry is bias
  enough — the launch prompt never hands agents a handle to shared items,
  only the proposal path. The `context.updated` event feed (with
  actor-via-key attribution) is the tripwire: if agents are observed
  editing shared tiers directly despite the guidance, add the guardrail.

## Acceptance criteria

1. Create a global prompt; it stitches first in every issue's launch
   prompt under `## Context: global`, across projects and workflows.
2. `tines context init` (and the Context-tab affordance) seeds
   `agent-guidelines` once; running it again is a no-op; the seeded item
   is editable and deletable like any other.
3. The launch prompt contains no item ids. Its `### Journal` section
   carries the append/show/rewrite commands addressed by the issue ref
   (with the create-on-first-append variant when no journal exists), and
   the shared-context footnote lists other effective items by kind, name,
   and scope label only.
4. Pasting the append command from the prompt adds a journal entry —
   creating the journal if absent — and the next prompt read shows the
   entry under its `## Journal (<scope label>)` heading and the bumped
   version; a non-journal prompt in the same layer keeps the ordinary
   `## Context:` heading.
5. Two concurrent appends both land. A rewrite with a stale
   `--expect-version` fails with a 409 naming the current version; after
   re-reading, the corrected body saves and drops the stale entry.
6. After the issue transitions, `tines journal append` writes the *new*
   state's journal.
7. An agent holding only the launch prompt and an API key can: comment,
   attach an issue-scoped artifact, append to the journal, correct the
   journal, and file a `Context change: <scope label>` issue — and the
   guidance text it was launched with told it which of those to do when.
8. All of the above appear in the activity feed with actor attribution;
   append events carry `appended: true`.
9. `tines projects create` without `--prompt` or `--no-prompt` fails with
   the teaching error; with `--prompt` the project and its `conventions`
   item land atomically and both events appear. A workflow create whose
   JSON gives a new state a `prompt` yields that state's `instructions`
   item; adding a promptless state without `--no-prompts` fails naming
   the state; `prompt` on an existing state is a 422. The new-project
   textarea and the editor's stage-instructions field produce the same
   items.

## Resolved questions

- **Versioned?** No history (unchanged non-goal). A monotonic `version`
  counter is added purely as a CAS token; chosen over `expected_updated_at`
  because millisecond timestamps can collide.
- **Progress vs instructions**: both are comments. Issue-scoped context
  items are artifact slots (skills, repo pins, overrides), not notes.
- **Correcting journal entries**: whole-body rewrite with
  `expected_version` — no entry-level structure; consolidation and
  correction are the same motion.
- **Biasing agents toward the journal**: affordance asymmetry, not
  permissions. Item ids were removed from the launch prompt entirely
  (an earlier draft listed every effective item's id and commands, which
  made editing shared context exactly as easy as journaling); the journal
  is addressed by issue ref via `tines journal`, sits in its own
  prompt-final section, and is the only item the prompt hands a write
  command for. Shared items appear by name only, with the proposal
  convention as their sole affordance.
- **Broad edits**: propose-only via convention (`Context change:` issues
  in the agent's current project), enforced by guidance and review rather
  than permissions; per-key scopes, structured payloads, and auto-apply
  wait for the curator/supervisor phase.
- **Where the encouragement lives**: in context itself — a seeded, fully
  user-owned global item — never in Tines-injected directive text; the
  issue block stays purely factual and only gains the mechanics sections.
- **Initial prompts at creation**: the nudge is client-level (CLI errors
  unless `--prompt`/`--no-prompt`; UI offers optional textareas — the
  asymmetry is deliberate: scripted creations forget systematically,
  humans facing an empty field don't), while the API stays optional and
  only contributes atomicity via `initial_prompt` / per-new-state
  `prompt` pass-through fields. Default names `conventions` (project) and
  `instructions` (state) are plain conventions with no special behavior.
