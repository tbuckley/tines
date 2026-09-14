# Tines — Starter bundles

A **starter** is a built-in bundle applied atomically with a project:
workflows (with their stage instructions), project context, a conventions
prompt, and the one issue that gives the new project something to run. It is
the mechanism behind the "start from" chooser (Tines/249) — this spec covers
the mechanism, not the content of any particular starter.

Implemented by `apps/web/src/lib/server/starters/` (content) and
`apps/web/src/lib/server/api/starters.ts` (the apply path), first shipped for
Tines/248.

## The bundle shape

A starter is a library document (`LibraryDocument`: `workflows` entries that
are literally `CreateWorkflowRequest`s, plus `context` entries — the format is
`specs/library/SPEC.md`) extended with:

- **typed inputs** — `repo_url`, `repo_branch`, `brief`, each declared with a
  label, a hint, `required`, and a max length. Values are trimmed; an absent
  optional input renders as the empty string.
- **`conventions_template`** — Markdown that prefills the project's
  `conventions` prompt, and the chooser's textarea.
- **`first_issue`** — a title and description template plus the workflow and
  state (both by *name*) the issue starts in.

Everything user-visible is a template rendered by `renderTemplate` with
`{{ key }}` placeholders. The variables are every declared input, plus
`project` (the new project's name) and `repo_name` (`repoDirFromUrl(repo_url)`,
empty when the starter has no repo). Unknown tokens are left intact.

Stage instructions travel as `states[].prompt` on the workflow, **not** as
context entries — see the collision rule for why.

`blank` is the absence of a starter, named: it declares nothing, and both
`starter: { id: 'blank' }` and an omitted `starter` produce a plain `Project`
with no `starter` key on the 201.

## Applying one

`POST /api/v1/projects` takes `starter: { id, inputs }`. The whole bundle
lands in `createProject`'s existing single `runAtomic` batch, in the order
foreign keys force:

```
workflow → states → transitions → stage prompts → inheritance pointers
project row → project.created
conventions → project context items → first issue
```

Calling `createWorkflow` / `createContextItem` / `createIssue` in sequence
would *not* work: each runs its own batch, and two of them read rows this
batch has not written yet. So the apply path does all of its reads first and
returns statements, via the `*Queries` builders (`workflowInsertQueries`,
`seedPromptQueries`, `seedRepoQueries`, `issueInsertQueries`) — the same house
pattern `seedPromptQueries` already used. A constraint violation anywhere
rolls the whole thing back and no project is created.

Every created row writes the event it would have written on its own path;
`project.created` and `workflow.created` additionally carry `starter: <id>`.

### Validation order

All starter rejections are 422s raised **before any read**, let alone any
write: `unknown_starter`, `unknown_starter_input` (a typo'd key is never
silently dropped — the whole point of an input is that it reaches the repo
item or the issue title), `missing_starter_input`, `invalid_field`. A
`default_workflow_id` alongside a starter that sets one is
`starter_sets_default_workflow`, not a silent override.

### The conventions rule

`initial_prompt` **present** — even `''` — is authoritative: `''` means no
conventions item. **Absent** falls back to the starter's rendered
`conventions_template`. Consequence for any UI: when a starter is selected,
send the textarea value verbatim rather than `value || undefined`, or a user
who clears the prefilled template gets it back.

## The collision rule

Per starter workflow, by name:

1. If a visible workflow with that name has an **identical fingerprint**
   (`workflowFingerprint` in `api/workflows.ts` — the same rule the library
   importer uses for "an identical workflow already exists"), it is
   **reused**: no workflow, state, transition or stage-prompt statements, and
   the first issue resolves its state against the existing workflow.
   `loadWorkflows` orders system-first then oldest-first, so the first match
   is the most canonical one.
2. Otherwise, if some workflow already has the name, the starter's is created
   as `<name> (<project>)`, with the *project* part truncated so the whole
   stays within 200 characters — a cosmetic rename must never fail the
   creation it decorates.
3. Otherwise it is created under its own name.

Two consequences, both accepted:

- **Reused workflows share their stage instructions across projects.** The
  `instructions` items are scoped to the workflow *state* with no project, so
  editing one project's stage prompt edits every project on that workflow —
  exactly how the shared `Engineering` workflow already behaves. A project ∧
  state override separates them later.
- **The fingerprint is blind to prompts.** It covers `initial_state`, the
  ordered state name/category tuples, and the transition set with its
  artifact requirements — not stage instructions, description or
  inheritance. State order is significant; transitions and requirements are
  compared without regard to order. The encoding is unambiguous canonical
  serialization (JSON tuples, not delimited text), so user text that spells
  a separator cannot make two different workflows fingerprint alike. So a
  workflow whose instructions were deleted still fingerprints identical and
  is reused *without* re-seeding them. Re-seeding would collide with
  `context_item_name_scope_uq` and take the whole creation down, which is a
  worse failure than a missing prompt.

## The menu

`GET /api/v1/projects/starters` returns `StarterSummary[]`: each starter's
id, name, description, inputs, `conventions_template`, and a `creates`
summary (workflows with their states and which is the default, context item
kinds and names, and the first issue). Names in `creates` may still contain
`{{ … }}` placeholders — the chooser renders them as it fills the form.

The 201 from `POST /api/v1/projects` carries the mirror image: `starter:
StarterApplied`, naming the workflows created or reused (`reused: true`), the
context items, and the first issue's id, number, ref and state.

## The chooser

The New-project dialog (`NewProjectModal.svelte`) opens with a **Start from**
radiogroup above Name, one stacked row per starter at every width — a
three-across grid does not fit `Modal size="md"` (~400 px of content on
desktop, ~310 px at 390 px). The menu comes from the page's server load, not a
client fetch: `listStarters()` is pure, so the dialog has no loading or
failure state. Blank is preselected, so a returning user's flow is unchanged.

Per-starter inputs are rendered from `inputs` — label, hint, `required` — so
starter *content* can change without touching the dialog. Which control an
input gets is read from the spec too: `max` above 1000 (or absent, i.e. the
10 000 default) means free-form prose and a textarea, anything shorter a
single-line field — never the input's key. The one remaining coupling to
starter ids is the per-card icon, which falls back to a generic one for an id
it does not know. Required inputs disable Create; nothing else is enforced
client-side, because a client rule that blocks a submit the server would
accept is worse than the 422 — a `maxlength` would make the server's cap
unreachable from the UI and hide the error path.

The conventions textarea is the dialog's own, and `initial_prompt` is sent
**verbatim**: the server's fallback to `conventions_template` only fires when
the field is absent, which from the UI it never is. A *pristine* textarea
mirrors the rendered template continuously, so typing Plan's brief — which its
template interpolates — updates the prefill live; the first edit freezes it,
and switching starters then asks before replacing it ("Replace" / "Keep mine").
The confirmation says which of the two is about to happen: a starter with no
template (Blank) *discards* the text rather than replacing it, and must not
promise a swap it cannot make. The starter switches either way; only the text
is at stake. Inputs are kept
across a switch so switching back restores them, and filtered to the selected
starter's declared keys on submit, so a stale key never 422s.

"This creates:" is rendered client-side by `$lib/starter-preview.ts` using the
server's exact variable set (`{ ...inputs, project, repo_name }`) — for the
prefill, blanks render as `''` as the server would; for the preview, as `…`,
so a half-filled form reads as a sentence. Two deliberate imprecisions: the
`Prompt "conventions"` line is added by the client (`creates.context` omits
it, because `createProject` seeds it itself) and only when the textarea is
non-blank; and the workflow lines say what a fresh project gets, ignoring the
collision rule above, because the client cannot know whether a workflow will
be reused or renamed. The project page shows the truth.

## Security

No run-key fence. `POST /projects`, `/workflows`, `/context` and `/issues` are
all run-key-legal today, so a starter fuses calls an agent can already make,
and it never overwrites anything — a name collision reuses or renames.
`/api/v1/import` is fenced because it *can* overwrite; this is not that.

## Clarified decision (Tines/327, 2026-09-09)

Starter validation is guaranteed before writes, though workflow matching and
inheritance reads may happen first. `conventions` is reserved for the separately
seeded project prompt; starter context cannot claim it. Conventions has position
0 and every declared starter context entry advances positions from 1, regardless
of kind or whether conventions was omitted.

Shared state prompts remain project-independent because structurally identical
workflows reuse them. After all workflow placements resolve, project context and
the first-issue description may render `project_id` and normalized
`workflow_<name>_{id,name}` variables. Plan therefore creates an editable
project-scoped `planning-guide` with the actual applied workflow bindings and
commands; this stays correct under full reuse and collision renames without
overwriting another project's shared instructions.

The CLI discovers starter inputs from `projects starters`; it does not duplicate
bundle definitions. Code accepts `--repo`/`--branch`, Plan accepts `--brief`, and
irrelevant or missing inputs fail before POST. A nonblank starter supplies its
prompt template unless `--prompt` or `--no-prompt` explicitly overrides it. Blank
and omitted starters retain the explicit prompt choice. A starter that sets a
default workflow conflicts with `--default-workflow`.

The chooser caps its first-issue preview at the server's 500-character limit and
bounds multiline rows with collision-safe index keys. Successful UI creation
carries a consumed navigation-state marker: only the untouched, sole active
first issue on the immediate unfiltered project arrival gets the first-issue and
Agents next-step callout. The marker is removed from history, so reloads and
ordinary later visits never replay onboarding guidance.

### Shared builders versus package reuse (Tines/435)

Portable workflow packages share the ordinary guarded workflow/context/label/
schedule/routing query builders with CRUD and starter machinery. This shares
validation and object/event shapes, not the starter's reuse policy: a workflow
package creates independently editable copies of every bundled workflow and
inheritance dependency, with destination-selected collision renames. Only declared
destination inputs are reused. Context prompts, skills and repos start with the
ordinary version-1 counter; they have no separate history table. No source history
is copied. The package installer must compile and check the complete batch budget
before submitting one transaction, rather than call starter/CRUD operations in a
loop.
