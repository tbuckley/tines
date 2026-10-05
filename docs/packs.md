# Packs

A **pack** is a folder of workflows and the context that goes with them (prompts, skills, env and
repo items), the **inputs** a project supplies, and **suggested schedules**. It is installed into a
project as a read-only copy, or authored there and exported as a `.tinespack` (a zip of the folder).
The design record is [specs/packs/MVP_SPEC.md](../specs/packs/MVP_SPEC.md); this guide says what
the code does.

## The folder

```
engineering/
├── pack.yaml              # format, id, name, version, description, inputs
├── README.md  CHANGELOG.md  migrations.yaml     # optional
├── project/               # every issue in the project
├── shared/                # issues in any of this pack's workflows
├── workflows/<wf>/        # workflow.yaml, plus items for any state of <wf>
│   └── states/<state>/    # items for one state
└── schedules/<name>.yaml  # suggested schedules
```

Each reach folder may hold `*.md` prompts (frontmatter `order`, `description`), `skills/<name>/`,
`env.yaml` and `repos.yaml`. Folder names are keys: `^[a-z][a-z0-9-]{0,62}$`. Skill files must be
UTF-8 text, because Tines stores skill files as text.

`tines packs validate <folder-or-file>` checks a pack offline with the same parser the server uses
(`packages/shared/src/packs/`): schema, keys, placeholders, size limits. Every error names its file.

## Inputs and placeholders

Inputs are `text`, `secret`, `repo` or `workflow`. `{{ inputs.<name> }}` is the only placeholder,
and only in prompts, skill `.md` files, `env.yaml` string values and schedule titles and
descriptions. `{{! inputs.x }}` escapes one (renders `{{ inputs.x }}`); any other `{{ … }}` is
literal. A secret never renders as text: bind an env variable to it (`NAME: { input: token }`).

Pack items store their text as templates. It is rendered with the project's values whenever
effective context is read — the issue's Context view, `tines issues context`, the launch prompt and
the shared execution bundle (`apps/web/src/lib/server/api/pack-render.ts`). A changed value applies
at the next run with nothing rewritten. A workflow input renders as one line naming the workflow and
the `tines issues create` command that files into it.

**Secret inputs are per person.** Each contributor supplies their own value
(`contributor_secret`); nobody can read anyone else's. At launch the run's contributor's value is
delivered as the env variable.

**Missing values.** A required input with no value (and no default), a workflow input whose
workflow was removed, or the contributor's own missing secret marks the pack *needs setup*. Dispatch
does not claim an issue while any pack item in its context reads such an input
(`packInputsMissingPredicate`, used by `loadEligibleIssues` and the claim). The issue's effective
context lists them as `missing_inputs`. An item counts even if a later layer overrides it by name.

## Where pack context stitches

For an issue in project P, in state S of workflow W:

1. global items;
2. each pack's `project/` items, in the project's pack order;
3. the project's own project-scoped items;
4. if W is in a pack: that pack's `shared/` items, W's workflow items, S's state items;
5. the project's own items on S (including the journal), then label and issue layers.

Prompts append in that order; skills, env and repos are named and the later layer wins. A project
with no packs stitches exactly as before. In the data model pack items are ordinary `context_item`
rows owned by the project owner, with `pack_id`, `reach` and (workflow reach) `workflow_id`; pack
workflows are ordinary `workflow` rows with `pack_id` and `key`, and states carry `key`.

## In a project

**Project → Packs** lists the project's packs in order, with *needs setup*, *newer version
available* (computed on load by comparing the source pack's digest) and *changed since export*.

- **Install** (`tines packs install <path> <project>`, or the Install page) reviews the pack —
  README, what it adds (project-wide items, env values, fixed repo URLs, states whose run scope
  reaches past their issue, `organization` flagged high risk), replacements, inputs, suggested
  schedules, and every prompt and skill rendered with the values typed — then installs exactly what
  was reviewed: the confirm call is refused unless the upload has the reviewed digest. A pack with a
  `project` or `organization` state can only be installed (or widened by a replace) from a browser.
  **From my projects** installs a pack from another project you can read; an authored source is
  exported at that moment, taking a new version if it changed.
- **Replace** (`tines packs replace`) needs the same pack id. It shows the newer CHANGELOG
  sections, every changed file with a diff, what changed in what the pack adds, new inputs and a
  **state mapping** for each removed state that holds issues, project additions or schedules,
  pre-filled from `migrations.yaml`. Applying it rewrites the pack's rows in place, matching
  workflows and states by key (after renames), so their ids survive. Moved issues keep their run
  permission. A project prompt that meets a same-named one on the target state is appended to it;
  another kind defers to the target's. A lower version, or the same version with different content,
  needs `confirm_version`.
- **Export** writes an installed pack's files byte for byte (same digest). An authored pack takes
  the next version when its content changed since the last export.
- **Detach** turns an installed pack into an authored one with a new id and `derived_from`.
- **Remove** is refused while an issue or schedule uses one of its workflows. It deletes the pack's
  workflows and items, the project's additions on its states, and unbinds workflow inputs in other
  packs that pointed at its workflows; the confirmation lists both.

An installed pack's items and workflows are read-only to everyone, people and runs alike
(`pack_read_only`). Add a project addition on the same state instead, or detach the pack.

## Authoring

**New pack** creates an authored pack with a random id. Copy a workflow used in the project into it
(its states, transitions, run scopes and state context, not journals; inheritance is flattened),
then optionally move this project's issues and schedules onto the copy through a state mapping. Add
prompts, env and repo items at any reach, move one of the project's own project-wide items in,
declare inputs, and **Suggest in pack** an existing schedule on one of the pack's workflows. Skills
are added as files: export to a folder, edit, and `tines packs replace` (Replace works on authored
packs too, as the round trip for a pack kept in git). Every authored edit is checked by writing the
pack out and parsing it again, so it is refused with the same message `validate` would print.

An authored pack's items are edited through the ordinary context API, except their scope, which
their reach sets. Workflows from packs are offered only in their pack's project.

## Suggested schedules

A suggestion renders its `{{ inputs.* }}` once, when a project schedule is created from it — on the
install screen (checked rows, enabled, in the browser's timezone) or with **Set up** on the pack
page. The created schedule is ordinary: a later value change or a Replace does not rewrite it.

## API

All under `/api/v1/projects/:id/packs`: list/create (`GET`/`POST`), `install/prepare`, `install`,
`:pack` (`GET`/`PATCH`/`DELETE`), `:pack/remove-preview`, `:pack/replace/prepare`, `:pack/replace`
(both accept `from_source: true`), `:pack/export` (`?format=zip` for the file), `:pack/detach`,
`:pack/values`, `:pack/my-secrets`, `:pack/workflows`, `:pack/workflows/:wf/move-issues`,
`:pack/items`, `:pack/schedules`, `:pack/schedules/:key`, `:pack/schedules/:key/set-up`. Plus
`/api/v1/packs/validate` and `/api/v1/packs/sources`. Uploads are `{ archive_b64 }` or
`{ files: [{ path, content_b64 }] }`. Run keys may read, validate and export.
