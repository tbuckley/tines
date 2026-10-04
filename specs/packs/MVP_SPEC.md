# Tines — Packs MVP

> Status: **proposed**, 2026-10-01. Nothing here has shipped. This is the
> reduced first version of the packs design in `specs/packs/SPEC.md`
> (tbuckley/tines#316). That spec stays as the longer-term record; where the
> two differ, this one is the decision for the MVP and the other describes
> where it may go next.

## In one paragraph

A **pack** is a folder you can zip, share and install into a project. It
holds workflows, the context that goes with them (prompts, skills, env, repos),
the **inputs** an installer must supply (text, secrets, repos, and other
workflows to hand work to), and **suggested schedules**. Installing a pack
gives the project a read-only copy whose text is rendered with the project's
input values each time a run launches. A newer version of the same pack
**replaces** the installed one in place, with a review and a state mapping, and
keeps everything the project supplied. There are no live links, no catalog
and no auto-update in this version: a new version arrives as a file, or from
the project you copied the pack from.

## Goals

- Share a workflow, or a set of workflows that hand work to each other, as one
  unit, with everything it needs to run.
- Reuse a pack across your own projects, and move each project to a newer
  version when you choose to.
- Let workflows refer to each other by role — *QA files bugs into Engineering*,
  *send human questions to Escalation* — and bind those roles per project.
- Make a pack's text reusable across projects through placeholders, rendered at
  launch.
- Show, before anything is installed or replaced, what the pack will add to
  agents' context and what access its states ask for.
- Change nothing for content that is not in a pack.

## Non-goals (deferred)

Each of these is in `specs/packs/SPEC.md` and can come later without changing
the format below.

- **Links that update on their own**: auto-update, review-mode links, chains of
  links (A → B → C). Replacement is always a person's choice.
- **A cloud catalog** of published packs, version listings and moderation.
  Existing public workflow snapshots (`docs/workflow-packages.md`) are
  unchanged.
- **Migrating existing workflows into packs.** User-owned workflows and their
  context keep working exactly as today. Packs are additive.
- **The user context layer** (`SPEC.md` decision 8).
- **Merging and splitting packs**, pack precedence editing, and per-state
  controls on installed workflows (review mode, initial state).
- **Access control on workflow inputs.** A workflow input says where a pack
  may file issues; it grants nothing beyond what the run's `run_scope` already
  allows.
- **Cross-project handoffs.** A workflow input binds to a workflow used in the
  same project.

## Concepts

| Term | Meaning |
| --- | --- |
| **Pack** | A versioned bundle of workflows, context, inputs and suggested schedules. In a project it is either **authored** or **installed**. |
| **Authored pack** | A pack being written in this project. Its content is editable here, and it can be exported. |
| **Installed pack** | A read-only copy of a pack version. It can be replaced by a newer version, detached, or removed. |
| **Pack id** | The pack's identity across versions and projects, written in `pack.yaml`. Replace only accepts a version with the same id. |
| **Version** | A positive integer in `pack.yaml`. Each export of a changed authored pack takes the next one. |
| **Key** | The stable name of a workflow or state: its folder name. Replace matches workflows and states by key, so their database ids, and everything that points at them, survive. |
| **Reach** | Which issues a context item applies to: the whole **project**, any of the **pack**'s workflows, one **workflow**, or one **state**. Set by the folder the item is in. |
| **Input** | A value the installing project supplies: `text`, `secret`, `repo` or `workflow`. |
| **Project additions** | The project's own context attached to an installed pack's states (including journals). Not part of the pack, and never touched by Replace. |
| **Source** | Where an installed pack came from: a file, or a pack in another project. A pack installed from another project can be replaced from that same source. |

## Folder layout

```
engineering/
├── pack.yaml                         # identity, version, inputs
├── README.md                         # shown on the install and replace screens
├── CHANGELOG.md                      # optional; shown on the replace screen
├── migrations.yaml                   # optional; state mappings between versions
│
├── project/                          # PROJECT reach: every issue in the project
│   ├── conventions.md
│   └── skills/
│       └── escalation/
│           └── SKILL.md
│
├── shared/                           # PACK reach: issues in any of this pack's workflows
│   ├── house-style.md
│   ├── env.yaml
│   ├── repos.yaml
│   └── skills/
│       └── pr-hygiene/
│           ├── SKILL.md
│           └── scripts/check.sh
│
├── workflows/
│   ├── engineering/                  # folder name = workflow key
│   │   ├── workflow.yaml             # states and transitions
│   │   ├── overview.md               # WORKFLOW reach: any state of this workflow
│   │   └── states/
│   │       ├── implement/            # folder name = state key
│   │       │   ├── instructions.md   # STATE reach
│   │       │   └── skills/…
│   │       └── review/
│   │           └── instructions.md
│   └── qa/
│       ├── workflow.yaml
│       └── states/
│           └── test/
│               └── instructions.md
│
└── schedules/
    └── weekly-triage.yaml            # a suggested schedule
```

**Reach folders** are `project/`, `shared/`, `workflows/<workflow>/` and
`workflows/<workflow>/states/<state>/`. Each may hold:

- `*.md` — prompts; the file stem is the prompt's name;
- `skills/<name>/` — a skill; the folder name is the skill's name;
- `env.yaml` — env items;
- `repos.yaml` — repo items.

Every folder and file is optional except `pack.yaml`. A pack with no
`workflows/` is a context pack: everything in it has project or pack reach,
and pack reach then applies to nothing, so the validator warns on a `shared/`
folder in a pack with no workflows.

**Keys.** Workflow and state keys are their folder names, as skill names are.
A key matches `^[a-z][a-z0-9-]{0,62}$`: it starts with a letter (YAML maps
keyed by a number-like string reorder when parsed in JavaScript), and it is
case-insensitive-unique among its siblings. A state whose key appears in
`workflow.yaml` does not need a folder; a state folder whose key is not in
`workflow.yaml` is an error.

**Not allowed in a pack:** a prompt named `journal` (journals belong to one
project — `specs/context/AGENT_EDITING.md`), secret values, issues, comments,
runs, artifacts, runner routing, model tiers, labels, and anything else a
project supplies.

## File formats

YAML throughout, for the people who do read these. Tines writes it with
two-space indentation and keys in the order shown below; it reads any valid
YAML 1.2 that matches the schema. Markdown files are UTF-8.

### `pack.yaml`

```yaml
format: 1                             # pack format version; Tines refuses a newer one
id: tbuckley/engineering              # stable across versions
name: Engineering
version: 4
description: Implement, review and ship changes, with QA filing bugs.
derived_from: { id: acme/engineering, version: 2 }   # set by Detach; informational

inputs:
  staging_url:
    type: text
    description: Base URL of the staging environment
    default: https://staging.example.com
  github_token:
    type: secret
    description: A GitHub token with repo scope
  app_repo:
    type: repo
    description: The application the agents work on
    default_branch: main
  bugs:
    type: workflow
    description: Where QA files the bugs it finds
    default: engineering/triage
  escalation:
    type: workflow
    description: Where agents send questions that need a human
```

- `id` matches `^[A-Za-z0-9][A-Za-z0-9._/-]{2,63}$`. A pack created in Tines
  gets a random id; a hand-written pack may choose a readable one.
- Input names match `^[a-z][a-z0-9_]{0,62}$`.

| Input type | Value the project supplies | Default | Required when |
| --- | --- | --- | --- |
| `text` | a string | `default:` | no default, unless `required: false` (then it renders as empty) |
| `secret` | a secret string, stored like an env secret today | none | always |
| `repo` | a URL and a branch | `default_branch:` (the URL never has a default) | always |
| `workflow` | a workflow used in this project, and optionally a start state | `default:` names a workflow in this pack, as `<workflow>` or `<workflow>/<state>` | no default |

### `workflow.yaml`

States are a map in display order; each state lists its own transitions, keyed
by the transition's name.

```yaml
name: Engineering
description: From triage to merged.
initial: triage
states:
  triage:
    name: Triage
    category: backlog
    transitions:
      Start: implement
  implement:
    name: Implement
    category: active
    run_scope: issue
    transitions:
      Ready for review: { to: review, requires: [pull_request] }
      Blocked: triage
  review:
    name: Human review
    category: awaiting_human
    transitions:
      Request changes: implement
      Approve: done
  done:
    name: Done
    category: done
```

- `category` is one of `backlog`, `active`, `awaiting_human`, `done`.
- `run_scope` is `issue` (the default), `project` or `workspace`.
- `Name: target` is shorthand for `Name: { to: target }`. `requires` lists
  artifact names the transition requires, as artifact requirements do today.
- Transition names are unique within their state. A non-`done` state with no
  transitions is a warning.
- No `inherits_from`: packs do not carry state inheritance.

### Prompts

Markdown, with optional frontmatter:

```markdown
---
order: 10
description: How we write commit messages
---
Write commit subjects in the imperative mood. Test against
{{ inputs.staging_url }} before handing off.
```

Within one reach folder, prompts stitch in ascending `order` (default `100`),
then by file name.

### Skills

A skill is a standard skill folder: `SKILL.md` with `name` and `description`
frontmatter (the `name` must equal the folder name), plus any other files.
Files keep their paths and bytes. Placeholders are rendered in the skill's
`.md` files only; scripts and other files are delivered byte for byte, and read
inputs through env vars.

### `env.yaml`

```yaml
LOG_LEVEL: info
API_BASE: "{{ inputs.staging_url }}/api"
GITHUB_TOKEN: { input: github_token }
```

A string value is a non-secret env item and may contain placeholders.
`{ input: <name> }` takes its value from a `secret` or `text` input; a secret
can only reach a run this way, never through a placeholder.

### `repos.yaml`

```yaml
app: { input: app_repo, dir: app }
docs: { url: https://github.com/acme/docs, branch: main, dir: docs }
```

The key is the repo item's name. A repo is either bound to a `repo` input (the
project supplies the URL and branch) or fixed (`url`, optional `branch` and
`dir`). Fixed URLs are listed on the install screen.

### `schedules/<name>.yaml`

```yaml
name: Weekly triage
workflow: engineering
start: triage                          # optional; defaults to the workflow's initial state
recurrence: { every: weekly, on: mon, at: "09:00" }   # or { cron: "0 9 * * 1" }
only_when_previous_closed: true
title: "Triage for {{ date }}"
description: |
  Sweep new bugs and assign priorities. Escalate anything unclear:
  {{ inputs.escalation }}
```

The recurrence fields match `tines issues create --every/--at/--on/--cron`.
There is no timezone: the project chooses one when it sets the schedule up.
The title template's existing variables (such as `{{ date }}`) are left for the
scheduler; only `{{ inputs.* }}` is a pack placeholder.

Unlike every other placeholder, a schedule's `{{ inputs.* }}` renders **once,
when the project schedule is created** from the suggestion, with the values the
project has then. The created schedule is an ordinary project schedule: its
title and description hold the rendered text (plus the scheduler's own
variables), and a later change to an input value, or a Replace, does not
rewrite it. To pick up a new value, edit the schedule or create it again.


### `migrations.yaml`

Tells Replace where issues go when a version removes or renames a state.

```yaml
"4":
  renamed:
    engineering/impl: engineering/implement
  removed:
    engineering/qa-check: engineering/review
```

- An entry applies when replacing any version lower than its own with that
  version or a later one; entries chain in version order.
- `renamed` keeps the state's identity under the new key: its id, issues,
  project additions and schedules carry over unchanged.
- `removed` pre-fills the state mapping (see Replace).
- A workflow can be renamed or removed by its key alone (`engineering`).

### `README.md` and `CHANGELOG.md`

Free Markdown, shown as is (no placeholders) on the install and replace
screens. The replace screen shows the CHANGELOG sections for versions newer
than the installed one when headed `## <version>`, and the whole file
otherwise.

## Placeholders

**Syntax.** `{{ inputs.<name> }}`, with optional spaces inside the braces. That
is the only placeholder. Any other `{{ … }}` is literal text and passes through
unchanged, so a skill that documents a templating language needs no escaping.

**Escaping.** One or more `!` straight after the opening braces escapes a
placeholder: the renderer removes one `!` and otherwise passes the text
through. So `{{! inputs.x }}` renders as `{{ inputs.x }}`, `{{!! inputs.x }}`
as `{{! inputs.x }}`, and so on, and any text can be written. An escaped
placeholder is not checked against the declared inputs. Escapes apply wherever
placeholders do (below); text that does not take placeholders, such as the
README, is shown as is.

**Where.** Prompts, `.md` files inside skills, string values in `env.yaml`, and
schedule `title` and `description`. Nowhere else: not in names, keys,
`workflow.yaml`, `repos.yaml` or the README.

**What each type renders as:**

| Type | Renders as |
| --- | --- |
| `text` | the value |
| `repo` | the URL |
| `secret` | not allowed in text; the validator refuses it |
| `workflow` | one line naming the workflow and the command to file into it, e.g. ``the "Engineering" workflow, starting in "Triage" — file with `tines issues create acme -w wf_123 -s Triage -t "<title>"` `` |

**When.** Text is stored exactly as authored, placeholders and all, and the
project's values are stored beside it. Rendering happens when a run launches,
and the launch snapshot (`0040_run_key_stage_snapshot`) keeps exactly what the
run read. So:

- changing a value takes effect at the next launch, with nothing rewritten;
- Replace brings new text and keeps the values;
- a workflow input always renders the bound workflow's current name, start
  state and id.

The one exception is a suggested schedule, which renders when the project
schedule is created from it (see `schedules/<name>.yaml`).

**Checked at install, not at launch.** An unknown input name, or a secret used
as a placeholder, fails validation before anything is installed.

**Missing values.** A required input without a value, or a workflow input
whose workflow was removed, marks the pack **needs setup**. A run is not
admitted while any item in its effective context references a missing value;
the refusal names the pack and the input.

**Showing context.** The effective-context view, `tines issues context`, the
launch prompt and the install and replace previews all render with the same
renderer. Pack pages offer a *raw* toggle to show the template.

## Packs in a project

A project's **Packs** page lists its packs in order, each with its kind
(authored or installed), id, version, source, and any *needs setup* or *newer
version available* badge.

**Workflows from packs** are owned by the project through the pack: they are
offered only in that project, in pickers as *Workflow · Pack*. A project's
existing workflows are unchanged.

### Where pack context stitches

For an issue in project P, in state S of workflow W:

1. global items — unchanged;
2. each pack's **project** items, packs in the project's pack order;
3. the project's own project-scoped items — unchanged;
4. if W is in a pack: that pack's **pack** items, then W's **workflow** items,
   then S's **state** items;
5. the project's own items on S, including the journal (project additions);
6. label, then issue layers — unchanged.

Prompts append in that order. Skills, repos and env items are named, and the
later layer wins, as today; the loser is reported in `overridden` with the
pack that decided it. So the project's own items beat a pack's at the same
level, and among packs a later one in the pack order beats an earlier one.
New packs are added at the end of the order, and Replace keeps a pack's place.
There is no precedence editor in the MVP.

An issue in a workflow that is not in a pack gets layers 1–3 and 5–6, so a
project with no packs stitches exactly as it does today.

## User flows

### Create a pack

Project → Packs → **New pack**: name and description. The pack is authored,
gets a random id, and has no version until its first export.

Then, inside the pack:

- **Add a workflow**: create one in the workflow editor, or **copy an existing
  workflow** used in this project. Copying brings its states, transitions,
  `run_scope` and state-scoped context (not journals). It then offers to
  **move this project's issues and schedules** onto the copy, through the
  state mapping screen, pre-filled by state name. Without that step the
  original keeps its issues and the copy starts empty.
- **Add context** at any reach: new prompts, skills, env and repo items, or
  **move** one of the project's own project-scoped items into the pack's
  `project/` reach.
- **Declare inputs** on the pack's Inputs tab, and give this project's values
  for them on the same tab. An authored pack's text renders with this
  project's values exactly as an installed one does.
- **Suggest a schedule**: from an existing schedule on one of the pack's
  workflows, **Suggest in pack** copies its definition into the pack.

An authored pack is live in its project: an edit applies at the next launch.

### Author a pack as files

Write the folder by hand, or with an agent, then:

```sh
tines packs validate ./engineering          # schema, keys, placeholders, limits
tines packs install ./engineering acme      # install into project "acme", read-only
tines packs install ./engineering acme --authored   # or as an editable authored pack
```

A pack kept in a git repo can be updated from the folder with
`tines packs replace ./engineering acme`, which works on authored and
installed packs alike (see Replace).

### Export

Pack → **Export**, or:

```sh
tines packs export <pack> --project acme -o engineering.tinespack
tines packs export <pack> --project acme --dir ./engineering
```

- **Authored pack**: if its content changed since the last export (or it was
  never exported), the export takes the next version number and Tines records
  that version's digest; otherwise it writes the same version again.
- **Installed pack**: writes the installed version unchanged — same id,
  version and digest — so it can be passed on.

Project values are never exported.

### Install

From a file: Project → Packs → **Install** → choose a `.tinespack`, or
`tines packs install <file-or-folder> <project>`.

From another project: Project → Packs → Install → **From my projects** lists
the packs in projects you can read. Installing one copies its current content:
an authored source is exported at that moment (taking a new version if it
changed), and an installed source gives its installed version. The source is
recorded.

Installing one pack id twice in a project is refused (*already installed*);
use Replace.

**The install screen** shows, in order:

1. the README;
2. **what this pack adds** — workflows and states; every `project/` item
   (*applies to every issue in this project*); env values and fixed repo URLs;
   states whose `run_scope` is `project` or `workspace`, with `workspace`
   marked high risk; suggested schedules;
3. **replacements** — items in this project the pack would override, or that
   would override the pack's;
4. **inputs** — a form for every input, pre-filled with defaults; workflow
   inputs offer this pack's workflows and the project's existing ones;
5. **schedules** — each suggested schedule, unchecked; a checked one is
   created as an ordinary project schedule, **enabled**, in a timezone that
   defaults to the person's current one (the browser's) and can be changed
   on the row, with its `{{ inputs.* }}` rendered with the values entered
   above. A schedule that references an input with no value cannot be checked
   until that value is given;
6. **prompts and skills** — a list of every prompt and skill by reach, each
   collapsed; opening one shows it rendered as an agent will read it.

Missing required inputs do not block the install; the pack is installed as
*needs setup*. Install is one transaction, and reuses the prepare → confirm →
receipt pipeline of workflow packages (`docs/workflow-packages.md`): the
confirmation is bound to the digest of what was reviewed.

### Replace

Pack → **Replace** with a file or folder, or, when the pack was installed from
another project and that source has changed, **Update from source**
(`tines packs replace <file-or-folder> <project>`, or
`tines packs replace --from-source <pack> <project>`).

The new version must have the same `id`. A lower version, or the same version
with a different digest, asks for confirmation.

**The replace screen** shows:

1. the CHANGELOG for the new versions;
2. **changed files** — a list of every added, changed and removed file, each
   collapsed; expanding one shows its diff;
3. **what changed in what the pack adds**, in the same terms as install — new
   `project/` items, new or wider `run_scope`, new env values and repo URLs,
   new suggested schedules;
4. **inputs** — new required inputs to fill here; removed ones are dropped.
   As at install, a missing value does not block the replace: the pack is
   left *needs setup*, and only runs whose effective context references the
   missing value are refused (see Placeholders);
5. **state mapping** — every removed state that holds issues, project
   additions or schedules must be mapped to a state that exists after the
   replace, pre-filled from `migrations.yaml`. Its issues, project additions
   and schedules move with the mapping, so a state with no issues still keeps
   the project's notes and schedules. Only a removed state that holds none of
   the three needs no mapping, and renamed keys need none;
6. **replacements** that the new version creates, changes or removes;
7. **prompts and skills**, listed and collapsed as at install; opening one
   shows it rendered with this project's values.

Collapsed sections are part of what is reviewed: the confirmation binds to the
digest of the whole version, whether or not each item was opened.

Applying rewrites the pack's rows in place, matching workflows and states by
key, so ids survive and issues, schedules, labels and project additions keep
pointing at them. Input values, schedules the project created, and the pack's
place in the order are kept. Runs already in progress finish on their launch
snapshot. A transition the new version no longer allows is refused, and the
refusal lists the transitions now available.

Replace on an **authored** pack overwrites its content with the file's: this
is the round trip for a pack kept as files. If the authored pack has edits
since its last export, the screen says so before they are discarded.

### Detach

Pack → **Detach** turns an installed pack into an authored one. It gets a new
random id and no version, records `derived_from` with the old id and version,
and keeps its input values and everything else. The source is forgotten, so
the old pack's versions can no longer replace it.

### Remove

Pack → **Remove**. Refused while any issue or schedule uses one of its
workflows; the refusal lists them, so they can be moved first. Removing
deletes the pack's workflows and context, and the project additions on its
states. Workflow inputs in other packs bound to its workflows become unbound,
so those packs show *needs setup*. The confirmation lists both before anything
is removed: the project additions that will be deleted, and each pack and
input that will become unbound.

### Change input values

Pack → **Inputs**. A change takes effect at the next launch. Changing a
workflow input's binding is the way to point a pack's handoffs at another
workflow.

## Who can do what

| Action | Browser | User API key (CLI) | Run key |
| --- | --- | --- | --- |
| validate, export, read packs and their diffs | yes | yes | yes |
| create and edit an authored pack | yes | yes | if `run_scope` reaches the project |
| set `run_scope` on an authored pack's state | yes | no | no (as `0047` set) |
| install, replace, detach, remove | yes | yes | no |
| install or replace a pack with a `project` or `workspace` state, or one that widens a `run_scope` | yes | no | no |
| set input values | yes | yes | no |

For the MVP any member of a project may do what the table allows.

**Agents and installed packs.** Editing an installed pack is refused at the
API, for people and runs alike, with an error naming the pack and suggesting a
project addition instead. The launch guidance tells agents that an installed
workflow is read-only and says where its pack came from. An agent that wants to
improve one files a context-change proposal (`specs/context/AGENT_EDITING.md`)
for a person to act on.

## The archive

- A `.tinespack` file is a zip of the pack folder. It may hold the files at the
  root or inside one top-level folder; export writes one top-level folder named
  after the pack.
- Paths are UTF-8 and use `/`. No absolute paths, `..`, symlinks, or two paths
  that differ only by case. Only `.md` and `.yaml` files are parsed; every
  other file must be inside a skill.
- Operating-system clutter is ignored wherever it appears: a `__MACOSX/`
  folder, `.DS_Store`, AppleDouble `._*` files, `Thumbs.db` and `desktop.ini`.
  It is dropped before validation, never counts as a second top-level folder,
  is left out of the digest, and is never written by export, so a pack
  re-zipped in Finder or Explorer still installs with the same digest.
- Size limits: the existing per-kind caps on prompts and skill files, and 5 MiB
  for the whole archive.
- **Digest**: SHA-256 over the sorted list of `<path>\0<sha256 of bytes>\n`
  lines. It does not depend on zip ordering, compression or timestamps, so
  re-zipping a pack does not change it. The confirmation step of install and
  replace binds to it.

## Data model sketch

Illustrative; a migration plan comes with implementation.

- `pack` — `id`, `project_id`, `pack_key` (the `pack.yaml` id; unique per
  project), `name`, `description`, `kind` (`authored` | `installed`), `version`,
  `digest`, `last_exported_version`, `last_exported_digest`, `source_kind`
  (`file` | `project`), `source_pack_id`, `derived_from`, `position`,
  `inputs` (the declarations, as JSON), `created_by`.
- `pack_input_value` — `pack_id`, `name`, and one of: text value, secret
  ciphertext (stored like an env secret), repo URL and branch, workflow id and
  optional state id.
- `workflow` gains `pack_id` and `key`; `workflow_state` gains `key`.
- `context_item` gains `pack_id`, `reach` (`project` | `pack` | `workflow` |
  `state`) and, for workflow reach, `workflow_id`. Pack items store their text
  as templates. Project additions are ordinary project ∧ state items, as today.
- `pack_schedule` — the pack's suggested schedules. A schedule created from one
  records which, for display only.
- `pack_snapshot` — the files of the installed or last exported version, for
  the replace diff and for re-export.

## Relation to existing features

- **Workflow packages and library import/export** (`docs/workflow-packages.md`,
  `specs/library/`) stay as they are. Packs reuse their prepare → confirm →
  receipt install pipeline. Converging the two formats is later work.
- **Starters** (`specs/starters/SPEC.md`) render inputs into items at creation.
  Packs render at launch instead, because a pack can be replaced and a starter
  cannot.
- **State inheritance** is not carried by packs. Copying an inheriting workflow
  into a pack flattens it: each state gets its base's context as its own.

## Decided questions

Decided 2026-10-04; each was an open question in the first draft.

1. **Built-in workflows stay as they are.** `Standard` and the other system
   workflows do not become installed packs in the MVP. Revisit with the cloud
   catalog, which is what would carry their new versions to every project.
2. **Newer versions are surfaced on the Packs page only.** *Newer version
   available* is computed when the Packs page loads, by comparing digests.
   Showing it more widely, such as on the Workflows page, is later work.
3. **Copy with issues stays within one project.** Copying an existing workflow
   into a pack offers to move issues and schedules only in the project where
   the pack is being created. It does not offer to do the same in other
   projects that use the original workflow; that belongs with migrating
   existing workflows into packs, which is a non-goal.
