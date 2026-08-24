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
primitives are an append and a compare-and-swap.

## Goals

- A **global scope** — the empty scope — whose items stitch into *every*
  launch prompt, first. This is where per-workspace agent guidance lives.
- Make the launch prompt self-sufficient for context maintenance: an agent
  holding only the prompt and a `TINES_API_KEY` knows which items apply,
  their ids and versions, and the commands to read, append to, and rewrite
  them — the same way it already knows how to comment and transition.
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
- **Enforcement of the tier etiquette**: API keys can still write any of
  the user's items. The broad-edit rule is convention plus review plus the
  event audit trail — per-key write scopes and hard ACLs are supervisor-
  phase work, as is auto-applying an approved proposal.
- **Issue types as a schema feature**: proposal issues are recognized by
  convention (title prefix), not a `type` column. A structured, machine-
  applyable proposal payload is deferred until a curator agent exists to
  consume it.
- **Auto-creating journals**: nothing materializes journal items; agents
  (or humans) create them with the ordinary create call when first needed.

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
pin, or a same-name override of a broader item. Not notes.

The **journal** is, by convention, the prompt item named `journal` scoped
to `project ∧ state`: lessons that help anyone doing this stage of work in
this project. Agents append freely and correct freely — the blast radius is
one project-stage, and the journal is precisely the consolidation target
the parent spec's journal example anticipated.

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

Correcting or pruning an entry is not a special operation: read the body
(it is in the agent's own launch prompt, or `GET /api/v1/context/:id`),
revise it, and PATCH the full body with `expected_version`. The same
motion serves consolidation, which the guidance encourages: rewrite, don't
only append.

### Context update proposals

To change project-, state-, or global-scoped context, an agent files an
ordinary issue — **in the project it is working in** — titled
`Context change: <scope label>`, whose description names the target item
(or proposes a new one: kind, name, scope) and contains the **full proposed
text**, not a delta. The human reviews it like any issue: discuss in
comments, apply the change through the normal context editor or CLI, and
close the issue; or close it rejected. Everything rides on existing rails —
comments for discussion, `awaiting_human` states for the review gate,
events for the audit trail.

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

### Launch prompt: the `### Context items` section

The generated issue block stays purely factual, and gains one section,
after `### Available transitions`:

```markdown
### Context items

- prompt "agent-guidelines" [global] — id ctx_aaa, v4
- prompt "house-conventions" [project Tines] — id ctx_bbb, v1
- prompt "journal" [project Tines · state Implementing] — id ctx_ccc, v7
- skill "review-checklist" [state Review] — id ctx_ddd, v2
- repo "tines-src" [issue Tines/1] — id ctx_eee, v1

Read: `tines context show <id> --json` · Append (prompts):
`tines context append <id> "<markdown>"` · Rewrite:
`tines context edit <id> --body @<file> --expect-version <v>` · Attach to
this issue: `tines context create --kind <k> --name <n> --issue Tines/1 …`
```

One line per **effective** item (post-dedupe, layer order), with its scope
label, id, and version — the id/version handshake that append and CAS need
— plus the command forms. Which tier to use when is *not* stated here;
that is guidance, and guidance is a context item (below). Like the rest of
the issue block, this is read-time formatting: no events, always current.

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
  (reuse its name). Never notes — notes are comments.
- **The journal** — the prompt item named "journal" scoped to your project
  and current state (see "Context items" below). Append a dated bullet
  whenever you learn something useful to anyone doing this stage of work
  in this project: commands that actually work, gotchas, where things
  live. If an entry is wrong or stale, rewrite the body to fix it — do not
  append a correction on top. Keep it short; prune when you touch it. If
  no journal exists yet, create one:
  `tines context create --kind prompt --name journal --project <p> --state <workflow>/<state> --body "- <date>: <lesson>"`
- **Context change requests** — never edit project-, state-, or global-
  scoped context directly. Propose instead: file an issue in the project
  you are working in, titled `Context change: <scope label>`, with the
  target item and the full proposed text in the description. A human
  reviews and applies it.

Mechanics: the "Context items" section at the end of this prompt lists
every applicable item with its id and version. Append with
`tines context append <id> "- <date>: <lesson>"`. To correct or
consolidate, fetch the body (`tines context show <id> --json`), revise,
then `tines context edit <id> --body @file --expect-version <v>` — a
version-conflict error means someone else wrote in between: re-read and
retry.
```

### Example launch prompt

For `Tines/1` sitting in *Implementing*, with the starter guidance, a house
prompt, and a journal in place, `tines issues prompt Tines/1` yields:

```markdown
## Context: global

You are an agent working on a Tines issue over its HTTP API / CLI. …
[the agent-guidelines body above]

## Context: project Tines

Use tabs. Write terse commit messages. Prefer small PRs.

## Context: project Tines · state Implementing

- 2026-08-20: `pnpm db:migrate:local` must run before the e2e suite.
- 2026-08-22: the D1 batch API is the only transaction primitive; see
  runAtomic in core.ts.

## Issue: Tines/1 — Ship context attachments

Implement the context spec end to end.

### Current state

Implementing (active), in workflow "Feature".

### Comments

No comments yet.

Add a comment: `tines issues comment Tines/1 "<markdown>"`

### Available transitions

- **submit** → Review (awaiting_human): `tines issues move Tines/1 "submit"`

### Context items

- prompt "agent-guidelines" [global] — id ctx_aaa, v4
- prompt "house-conventions" [project Tines] — id ctx_bbb, v1
- prompt "journal" [project Tines · state Implementing] — id ctx_ccc, v7

Read: `tines context show <id> --json` · Append (prompts):
`tines context append <id> "<markdown>"` · Rewrite:
`tines context edit <id> --body @<file> --expect-version <v>` · Attach to
this issue: `tines context create --kind <k> --name <n> --issue Tines/1 …`
```

The guidance explains *when*; the context-items section supplies the *how*
(ids, versions, commands); comments and transitions were already covered.
An agent holding only this text can journal, correct the journal, attach
artifacts, and file a `Context change:` proposal.

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
| `PATCH /api/v1/context/:id` | Accepts `expected_version`; 409 with the current item on mismatch. Unsetting the last scope dimension now yields a global item instead of a 422. |
| `POST /api/v1/context/:id/append` | New. `{ text, expected_version? }`; prompts only; atomic; cap-checked; returns the updated item. |
| everywhere items serialize | `version` included (list rows, detail, effective-context entries). |
| `GET /api/v1/issues/:id/prompt` | Issue block gains the `### Context items` section. |

## CLI

```
tines context append <id> <markdown>
tines context edit <id> … --expect-version <n>
tines context create …                       # scope flags now optional → global
tines context init                           # seed agent-guidelines if absent
```

`context list` renders global items with scope `global`; everything else is
unchanged.

## Web UI

- Scope picker: empty selection is valid, summarized as "Global — applies
  to every launch prompt"; `global` chips in lists and the Context tab.
- Context tab: "Add starter agent guidance" affordance when no global
  `agent-guidelines` exists.
- Conflict handling: the editor sends `expected_version` from the item it
  loaded and surfaces the 409 as "changed since you opened it — reload".

## Acceptance criteria

1. Create a global prompt; it stitches first in every issue's launch
   prompt under `## Context: global`, across projects and workflows.
2. `tines context init` (and the Context-tab affordance) seeds
   `agent-guidelines` once; running it again is a no-op; the seeded item
   is editable and deletable like any other.
3. `tines issues prompt` lists every effective item with scope label, id,
   and version in `### Context items`; pasting the append command from the
   prompt adds a journal entry, and the next prompt read shows both the
   new entry and the bumped version.
4. Two concurrent appends both land. A rewrite with a stale
   `--expect-version` fails with a 409 naming the current version; after
   re-reading, the corrected body saves and drops the stale entry.
5. An agent holding only the launch prompt and an API key can: comment,
   attach an issue-scoped artifact, append to the journal, correct the
   journal, and file a `Context change: <scope label>` issue — and the
   guidance text it was launched with told it which of those to do when.
6. All of the above appear in the activity feed with actor attribution;
   append events carry `appended: true`.

## Resolved questions

- **Versioned?** No history (unchanged non-goal). A monotonic `version`
  counter is added purely as a CAS token; chosen over `expected_updated_at`
  because millisecond timestamps can collide.
- **Progress vs instructions**: both are comments. Issue-scoped context
  items are artifact slots (skills, repo pins, overrides), not notes.
- **Correcting journal entries**: whole-body rewrite with
  `expected_version` — no entry-level structure; consolidation and
  correction are the same motion.
- **Broad edits**: propose-only via convention (`Context change:` issues
  in the agent's current project), enforced by guidance and review rather
  than permissions; per-key scopes, structured payloads, and auto-apply
  wait for the curator/supervisor phase.
- **Where the encouragement lives**: in context itself — a seeded, fully
  user-owned global item — never in Tines-injected directive text; the
  issue block stays purely factual and only gains the mechanics section.
