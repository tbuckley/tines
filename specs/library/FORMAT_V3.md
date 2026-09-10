# Tines library format v3

Status: implementation contract for private file exchange. Public discovery and remote dependency fetching are not part of v3.

## Envelope and identity

A v3 document is UTF-8 JSON no larger than 5 MiB. Its required envelope is:

```json
{
  "format": "tines.library",
  "version": 3,
  "profile": "workflow",
  "exported_at": 1789063200000,
  "digest": "sha256:…"
}
```

`profile` is `workflow` for an atomic, independently editable workflow package and `library` for the existing best-effort whole-library transfer. Unknown fields, duplicate object keys (including escape-equivalent keys), invalid UTF-8, lone UTF-16 surrogates, non-finite numbers, unsafe integer fields, and nesting deeper than 64 are invalid.

The digest is SHA-256 over the UTF-8 bytes of RFC 8785 JCS serialization after removing only the top-level `digest` member. All remaining metadata and array order participate. Whitespace and object member order do not. Validate may accept a missing digest for authoring and returns the canonical digest-bearing document; prepare and install require it to match.

All record IDs are document-local opaque strings matching `[A-Za-z0-9:_-]{1,80}`. They are unique across record kinds. They are not database IDs and never imply equality with another file or destination object. A package contains no more than 1,000 records in total.

## Workflow profile

The envelope additionally requires `main_workflow_id`, `workflows`, `context`, `inputs`, `text_uses`, `schedules`, and `routing`. Arrays are required even when empty.

```ts
interface Workflow {
  id: LocalId; name: string; description: string; initial_state_id: LocalId;
  states: Array<{
    id: LocalId; name: string; category: StateCategory;
    inherits_from: { kind: "bundled_state"; state_id: LocalId } | null;
  }>;
  transitions: Array<{
    id: LocalId; name: string; from_state_id: LocalId; to_state_id: LocalId;
    requires: ArtifactRequirement[];
  }>;
}
```

`main_workflow_id` identifies exactly one bundled workflow. Every other workflow must be reachable through required state inheritance. The package includes the complete transitive dependency definitions, including Standard when required; installation always creates independent ordinary copies. Initial and transition endpoints belong to their enclosing workflow. State inheritance is cycle-free and at most three states deep.

Context records have an `id`, exact `state_id`, `kind`, `name`, and `description`. Prompt records carry `body`; skills carry ordered `{id,path,content}` files; repos carry `repo_url`, nullable `repo_branch`, and nullable `repo_dir`. Array order is the context order at that exact state scope. Instructions are prompt records named `instructions`. Journals, ambient global/project context, issue content, artifacts, credentials, and history are excluded.

References are discriminated objects. v3 accepts only bundled state/workflow and declared input workflow/project references. A future format may add an immutable reference such as `{kind:"public_snapshot",host,snapshot_id,digest}`; v3 rejects it and never fetches a URL.

## Declared inputs and text uses

An input has `id`, unique lower-case `key`, `type` (`text`, `workflow`, `label`, or `project`), `label`, `description`, `required`, nullable string `default`, and optional `required_states` for workflow inputs. Object defaults are name suggestions, never authority. Project/workflow matches must be accessible and unambiguous. A label choice explicitly says reuse or create.

A text use is `{id,target:{record_id,field},input_id,token}`. Allowed fields are workflow description; prompt body/description; skill text-file content/description; repo description; and schedule title/description templates. A token is `{{key:default}}`; backslash, colon, and closing brace in its default are backslash-escaped. `\{{key:default}}` is literal. Only declared occurrences in the named field are rendered, exactly once. Values containing token syntax are not expanded recursively. Runtime schedule placeholders and undeclared token-looking prose remain literal.

Schedules reference a bundled workflow and an input project. They preserve recurrence as `{kind:'preset',preset:SchedulePreset}` or `{kind:'cron',cron:string}` (exactly one branch), timezone, templates, `require_all_closed`, and either follow-initial (`start_state: null`) or an explicit bundled state. Installation creates selected schedules paused, with no run count, issue, or dispatch.

Routing entries target a bundled state with an optional input project and contain a portable tier, never a publisher runner ID. Preparation checks the destination's actual eligible capabilities and ordinary routing specificity.

## Confirmation and installation

Preparation is read-only and returns the complete rendered content, operations, destination choices, signed 15-minute plan, document digest, and plan digest. The plan binds actor, owner, destination witnesses, names, values, schedules, routing, allocated IDs, and compiler version. Editing any bound choice requires a new plan and confirmation.

Installation requires a session or named API key; an agent run key may export, validate, and prepare but cannot install. One guarded D1 batch first inserts a request-specific receipt, then gates every object, file/version, inheritance, and event statement on that receipt and an attempt-specific execution nonce. Failure or stale witnesses write nothing. A matching durable receipt makes concurrent retries and lost-response retries return one result without duplication, including after plan expiry. Success creates ordinary editable objects, selected paused schedules, and tier-only rules; it creates no issue and changes no project default.

## Compatibility

Versions 1 and 2 remain readable by the legacy best-effort importer. Version 1 has no inheritance semantics: an absent or permissively present inheritance field can neither compare, set, nor clear a destination pointer in either collision mode. Version 2 retains its existing merge semantics. Ambiguous legacy workflow names or slash-delimited state references are refused rather than guessed. Whole-library v3 uses local IDs so duplicate names and their prompts remain distinct, but it retains best-effort rather than atomic guarantees.


## Complete record schema and limits

The executable strict shape boundary is `packages/shared/src/library/schema.ts`, followed by `references.ts`; public interfaces are in `types.ts`. Every member below is required unless marked `?`, including nullable fields and empty arrays. Members of another union branch are unknown fields, not ignored data. All names must have nonempty trimmed text. Validation does not rewrite strings, normalize Unicode or normalize line endings before hashing. Later ordinary-object planning must retain and review any domain normalization.

| Record | Members beyond `id` |
| --- | --- |
| Workflow | `name` (200 characters), `description` (10,000), `initial_state_id`, `states[]`, `transitions[]` |
| State | `name` (100), `category` (`backlog`, `active`, `awaiting_human`, `done`), `inherits_from` (state reference or null) |
| Transition | `name` (100), `from_state_id`, `to_state_id`, `requires[]` |
| Requirement (no ID) | `artifact` (100, `[a-z0-9-]+`), optional `type` (`file`, `text`, `link`, `pr`, `folder`), optional `content_type` (100, only with file/text), optional `description` (500) |
| Context common | `kind`, `name` (100), `description` (1,000), profile-specific scope below |
| Prompt payload | `kind:prompt`, `body` (32 KiB UTF-8) |
| Skill payload | `kind:skill`, `files[]`; name is `[a-z0-9-]+` |
| File | `path` (500), `content`; at most 20 files and 100 KiB UTF-8 total including paths per skill |
| Repo payload | `kind:repo`, `repo_url` (1,000), `repo_branch` (200 or null), `repo_dir` (500 or null) |
| Input | `key` (`[a-z][a-z0-9_]{0,63}`), `type` (`text`, `workflow`, `label`, `project`), `label` (200), `description` (1,000), `required` boolean, `default` (10,000 or null), optional unique `required_states[]` (names of at most 100 characters, workflow input only) |
| Text use | `target:{record_id,field}`, `input_id`, `token` (30,100 characters, exact encoding of input key/default) |
| Schedule | `workflow:{kind:bundled_workflow,workflow_id}`, `project:{kind:input_project,input_id}`, `name` (200), `title_template` (500), `description_template` (100,000), `recurrence`, `timezone` (100, valid IANA zone), `require_all_closed` boolean, `start_state` (bundled-state reference or null) |
| Tier preference | `scope:{state_id,project?:{kind:input_project,input_id}}`, `tier` (`smartest`, `balanced`, `cheapest`) |
| Library project | `name` (200), `description` (10,000), `default_workflow` (bundled-workflow reference, `{kind:system_workflow,name:Standard}` or null) |
| Library label | `name` (ordinary label limit, no control characters or leading hyphen), `color` (ordinary `LABEL_COLORS` palette) |

Package context has `state_id` only. Library context has `scope:{project_id?,state?,label_id?}` and `journal:boolean`; empty scope is global and journals must be prompts. A library `scope.state` or state `inherits_from` accepts `{kind:bundled_state,state_id}` or `{kind:system_state,workflow:Standard,state_name}`. The known Standard state names are exactly `Open`, `Human Review`, `Closed`; destination planning must also verify the actual system record. System references confer no authority through owned workflow names. A workflow package never accepts system refs: it bundles the complete required Standard data as an independent copy. Library profile has no `inputs`, `text_uses`, `schedules`, `routing`, or `main_workflow_id`; its envelope arrays are `workflows`, `context`, `projects`, `labels`.

A schedule recurrence is `{kind:cron,cron}` (at most 100 characters) or `{kind:preset,preset}`. Presets are exact objects: hourly `{kind:hourly,every_hours,minute?}`, daily `{kind:daily,time}`, weekly `{kind:weekly,time,weekday}`, monthly `{kind:monthly,time,day_of_month}`. Numeric fields are safe nonnegative integers; ordinary recurrence validation enforces every_hours 1–23, minute 0–59, weekday 0–6, day_of_month 1–31 and valid time. Cron must pass the ordinary five-field, at-most-hourly validator. Preset intent is preserved; no contradictory compiled cron may accompany it.

Paths use forward slashes, are relative, and contain no empty, `.` or `..` segments or equals signs. Repository URLs must be GitHub HTTPS repository URLs accepted by the ordinary canonicalizer, without userinfo/query/fragment; no network resolution or fetch occurs. Branches are nullable nonempty text; a value is not a shell command.

State names are unique within each workflow after ordinary trimming. Initial states are backlog/active; no self transitions; action names are unique case-insensitively per source state. Requirement artifact names are unique per transition. Context kind/name is unique at an exact scope; filenames and input keys are unique in their enclosing groups. Workflow names may repeat with distinct IDs. Library project names and case-insensitive label names are unique. Each routing scope has at most one preference. Every reference is checked by record kind; start states belong to their scheduled workflow. A file record cannot satisfy a state or input reference. The 1,000-record total includes workflows, states, transitions, context, files, inputs, text uses, schedules and routing (and library projects/labels), not just each array separately.

### Executable examples and golden digests

- [`examples/inherited-workflow.json`](examples/inherited-workflow.json): main Reviewer plus complete Shared dependency, inherited instructions, skill bytes, repo declaration, artifact gate, filing-label input, no project or automation. Digest `sha256:188befe188e05dbdb6ac2e11de0541d2336abaca95f7a9b3f4a77ef027bf386a`.
- [`examples/project-automation.json`](examples/project-automation.json): same closure with a declared project input, optional weekly schedule and balanced tier. Digest `sha256:758f33fd2a2936ac9a7ef72b8c9c9aa7f7cde88d098dd12006dc9f193c878e74`.
- [`examples/duplicate-library.json`](examples/duplicate-library.json): two identically named workflows with different state instructions and a project default tied to the second ID; includes global and system/project/label-scoped journal data. Digest `sha256:f09845183e1f44cbc2ea2b104c42de3dac01633f1666f1a0605a94d3c5abe18d`.

The shared test suite parses the actual example files and compares them to independently fixed golden digests and executable authoring fixtures. These are synthetic contract fixtures, not account-install or runner acceptance evidence.

### Input rendering boundary

`renderPackageFields` accepts already-resolved destination display values and returns original/rendered fields with use IDs, input IDs and occurrence counts. It verifies post-substitution field limits, including combined skill bytes, before returning patches. The original document and digest are unchanged. Only fields named by a declared use may change: workflow description; context description; prompt body; skill file content; schedule title/description template. Values are never rescanned; all matches come from the original field, and duplicate or overlapping declarations fail. An escape before a declared token removes exactly one backslash and leaves a literal token. Other backslashes and undeclared/runtime placeholders remain unchanged.

### Transport and transaction budgets (installer gate)

The file cap is independently 5 MiB, outer JSON envelope cap 32 MiB, decoded signed plan cap 512 KiB, and choices cap 512 KiB. Bound reads before parsing. The envelope carries raw `document_json` so duplicate keys survive transport until strict validation. Prepared compilation must reject more than 800 statements, 90 parameters or 90 KiB SQL in one statement, or 1 MiB in one stored value. These conservative installation budgets still require native D1 boundary evidence before release; shared schema tests do not prove the database transaction contract.

Prepare/install/receipt behavior above is the planned contract, not a claim those surfaces have shipped. A committed receipt identifies plan, document and plan digests, committed time, created object IDs/kinds/names/links, main/dependency roles and reused input identities; it contains no source prose, resolved text values or plan bearer token. Generic transport errors mean outcome unknown, not rollback; retry/recover the same plan. Only a definite failed transaction/server result supports “nothing created.” A receipt 404 while an install may be in flight cannot authorize a replacement plan.
