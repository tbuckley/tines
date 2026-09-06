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
- **The fingerprint is blind to prompts.** It covers `initial_state`, each
  state's `name:category`, and the transition set with its artifact
  requirements — not stage instructions, description or inheritance. So a
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

## Security

No run-key fence. `POST /projects`, `/workflows`, `/context` and `/issues` are
all run-key-legal today, so a starter fuses calls an agent can already make,
and it never overwrites anything — a name collision reuses or renames.
`/api/v1/import` is fenced because it *can* overwrite; this is not that.
