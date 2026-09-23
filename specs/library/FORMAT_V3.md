# Tines library format v3

Status: implementation contract for private file exchange. Public discovery and remote dependency fetching are not part of v3.

## Superseding mutation policy — 2026-09-22

This document retains the signed v3 examples and historical parsing contract.
For new mutation, state inheritance is retired: exports contain one selected
workflow and exact state-scoped context, with no dependency closure or pointer
linking. Pointer-bearing documents, including malformed non-null
`inherits_from` values after valid envelope decoding, remain available for
strict inspection and download but are refused by prepare and install before
allocation or writes. Whole-library inspection continues to use the historical
reader. A matching authenticated committed receipt is recovered before the
retired-input eligibility check.

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
    inherits_from: null;
  }>;
  transitions: Array<{
    id: LocalId; name: string; from_state_id: LocalId; to_state_id: LocalId;
    requires: ArtifactRequirement[];
  }>;
}
```

`main_workflow_id` identifies exactly one bundled workflow. A current package
contains only that workflow; it has no dependency closure and no pointer
linking. Installation creates an independent ordinary copy. Initial and
transition endpoints belong to the enclosing workflow. Historical pointer-
bearing documents remain parseable for inspection only and are rejected by
prepare/install before allocation or writes.

Context records have an `id`, exact `state_id`, `kind`, `name`, and `description`. Prompt records carry `body`; skills carry ordered `{id,path,content}` files; repos carry `repo_url`, nullable `repo_branch`, and nullable `repo_dir`. Array order is the context order at that exact state scope. Instructions are prompt records named `instructions`. Journals, ambient global/project context, issue content, artifacts, credentials, and history are excluded.

References are discriminated objects. v3 accepts only bundled state/workflow and declared input workflow/project references. A future format may add an immutable reference such as `{kind:"public_snapshot",host,snapshot_id,digest}`; v3 rejects it and never fetches a URL.

## Declared inputs and text uses

An input has `id`, unique lower-case `key`, `type` (`text`, `workflow`, `label`, or `project`), `label`, `description`, `required`, nullable string `default`, and optional `required_states` for workflow inputs. Object defaults are name suggestions, never authority. Project/workflow matches must be accessible and unambiguous. A label choice explicitly says reuse or create.

A text use is `{id,target:{record_id,field},input_id,token}`. Allowed fields are workflow description; prompt body/description; skill text-file content/description; repo description; and schedule title/description templates. A token is `{{key:default}}`; backslash, colon, and closing brace in its default are backslash-escaped. `\{{key:default}}` is literal. Only declared occurrences in the named field are rendered, exactly once. Values containing token syntax are not expanded recursively. Runtime schedule placeholders and undeclared token-looking prose remain literal.

Schedules reference a bundled workflow and an input project. They preserve recurrence as `{kind:'preset',preset:SchedulePreset}` or `{kind:'cron',cron:string}` (exactly one branch), timezone, templates, `require_all_closed`, and either follow-initial (`start_state: null`) or an explicit bundled state. Installation creates selected schedules paused, with no run count, issue, or dispatch.

Routing entries target a bundled state with an optional input project and contain a portable tier, never a publisher runner ID. Preparation checks the destination's actual eligible capabilities and ordinary routing specificity.

## Confirmation and installation (planned; not implemented by the foundation)

Preparation is read-only and returns the complete rendered content, operations, destination choices, signed 15-minute plan, document digest, and plan digest. The plan binds actor, owner, destination witnesses, names, values, schedules, routing, allocated IDs, and compiler version. Editing any bound choice requires a new plan and confirmation.

Installation requires a session or named API key; an agent run key may export, validate, and prepare but cannot install. One guarded D1 batch first inserts a request-specific receipt, then gates every object, file/version, and event statement on that receipt and an attempt-specific execution nonce. Failure or stale witnesses write nothing. A matching durable receipt makes concurrent retries and lost-response retries return one result without duplication, including after plan expiry. Success creates ordinary editable objects, selected paused schedules, and tier-only rules; it creates no issue and changes no project default.

## Compatibility

Versions 1 and 2 remain readable by the legacy best-effort inspector/import boundary. Historical pointer-bearing inputs remain inspectable but cannot create, update, clear, or relink a destination pointer. Ambiguous legacy workflow names or slash-delimited state references are refused rather than guessed. Whole-library v3 uses local IDs so duplicate names and their prompts remain distinct, but it retains best-effort rather than atomic guarantees.


## Complete record schema and limits

The executable strict shape boundary is `packages/shared/src/library/schema.ts`, followed by `references.ts`; public interfaces are in `types.ts`. Every member below is required unless marked `?`, including nullable fields and empty arrays. Members of another union branch are unknown fields, not ignored data. All names must have nonempty trimmed text. Validation does not rewrite strings, normalize Unicode or normalize line endings before hashing. Later ordinary-object planning must retain and review any domain normalization.

| Record | Members beyond `id` |
| --- | --- |
| Workflow | `name` (200 characters), `description` (10,000), `initial_state_id`, `states[]`, `transitions[]` |
| State | `name` (100), `category` (`backlog`, `active`, `awaiting_human`, `done`), `inherits_from: null` |
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

Package context has `state_id` only. Library context has `scope:{project_id?,state?,label_id?}` and `journal:boolean`; empty scope is global and journals must be prompts. A library `scope.state` is an exact state scope and may reference a bundled or known Standard state. A workflow package never accepts system refs. Library profile has no `inputs`, `text_uses`, `schedules`, `routing`, or `main_workflow_id`; its envelope arrays are `workflows`, `context`, `projects`, `labels`.

A schedule recurrence is `{kind:cron,cron}` (at most 100 characters) or `{kind:preset,preset}`. Presets are exact objects: hourly `{kind:hourly,every_hours,minute?}`, daily `{kind:daily,time}`, weekly `{kind:weekly,time,weekday}`, monthly `{kind:monthly,time,day_of_month}`. Numeric fields are safe nonnegative integers; ordinary recurrence validation enforces every_hours 1–23, minute 0–59, weekday 0–6, day_of_month 1–31 and valid time. Cron must pass the ordinary five-field, at-most-hourly validator. Preset intent is preserved; no contradictory compiled cron may accompany it.

Paths use forward slashes, are relative, and contain no empty, `.` or `..` segments or equals signs. Workflow-package repository URLs must be GitHub HTTPS repository URLs accepted by the canonicalizer, without userinfo/query/fragment; no network resolution or fetch occurs. Whole-library backups preserve ordinary repository declarations, including local URLs used by managed runners. Branches are nullable nonempty text; a value is not a shell command.

State names are unique within each workflow after ordinary trimming. Initial states are backlog/active; no self transitions; action names are unique case-insensitively per source state. Requirement artifact names are unique per transition. Context kind/name is unique at an exact scope; filenames and input keys are unique in their enclosing groups. Workflow names may repeat with distinct IDs. Library project names and case-insensitive label names are unique. Each routing scope has at most one preference. Every reference is checked by record kind; start states belong to their scheduled workflow. A file record cannot satisfy a state or input reference. The 1,000-record total includes workflows, states, transitions, context, files, inputs, text uses, schedules and routing (and library projects/labels), not just each array separately.

### Historical executable examples and golden digests

- [`examples/inherited-workflow.json`](examples/inherited-workflow.json): main Reviewer plus complete Shared dependency, inherited instructions, skill bytes, repo declaration, artifact gate, filing-label input, no project or automation. Digest `sha256:188befe188e05dbdb6ac2e11de0541d2336abaca95f7a9b3f4a77ef027bf386a`.
- [`examples/project-automation.json`](examples/project-automation.json): same closure with a declared project input, optional weekly schedule and balanced tier. Digest `sha256:758f33fd2a2936ac9a7ef72b8c9c9aa7f7cde88d098dd12006dc9f193c878e74`.
- [`examples/duplicate-library.json`](examples/duplicate-library.json): two identically named workflows with different state instructions and a project default tied to the second ID; includes global and system/project/label-scoped journal data. Digest `sha256:f09845183e1f44cbc2ea2b104c42de3dac01633f1666f1a0605a94d3c5abe18d`.

The shared test suite parses the actual example files and compares them to independently fixed golden digests and executable authoring fixtures. These are synthetic contract fixtures, not account-install or runner acceptance evidence.

### Input rendering boundary

`renderPackageFields` accepts already-resolved destination display values and returns original/rendered fields with use IDs, input IDs and occurrence counts. It verifies post-substitution field limits, including combined skill bytes, before returning patches. The original document and digest are unchanged. Only fields named by a declared use may change: workflow description; context description; prompt body; skill file content; schedule title/description template. Values are never rescanned; all matches come from the original field, and duplicate or overlapping declarations fail. An escape before a declared token removes exactly one backslash and leaves a literal token. Other backslashes and undeclared/runtime placeholders remain unchanged.

### Transport and transaction budgets (installer gate)

The file cap is independently 5 MiB, outer JSON envelope cap 32 MiB, decoded signed plan cap 512 KiB, and choices cap 512 KiB. Bound reads before parsing. The envelope carries raw `document_json` so duplicate keys survive transport until strict validation. Prepared compilation must reject more than 800 statements, 90 parameters or 90 KiB SQL in one statement, or 1 MiB in one stored value. These conservative installation budgets still require native D1 boundary evidence before release; shared schema tests do not prove the database transaction contract.

Prepare/install/receipt behavior above is the planned contract, not a claim those surfaces have shipped. A committed receipt identifies plan, document and plan digests, committed time, created object IDs/kinds/names/links, the selected workflow and reused input identities; it contains no source prose, resolved text values or plan bearer token. Generic transport errors mean outcome unknown, not rollback; retry/recover the same plan. Only a definite failed transaction/server result supports “nothing created.” A receipt 404 while an install may be in flight cannot authorize a replacement plan.

### Whole-library HTTP mapping

`GET /api/v1/export` returns `profile:library`; `journals=false` excludes journals. `version=2` explicitly requests the older name-based compatibility export. `POST /api/v1/import` accepts `{document,dry_run?,on_collision?,create_projects?,include_journals?,workflow_targets?}`. V1/v2 remain readable. `workflow_targets` is a map from local workflow ID to `{kind:"target",workflow_id:<owned destination ID>}` or `{kind:"create",name:<unused destination name>}`. Unknown local IDs, invalid choices, and many-to-one mappings do not silently select another workflow.

Without a collision, duplicate source names remain separate objects. A unique destination name may match as before; ambiguous names require explicit choices. Settings proposes independent, unused create names for ambiguous groups, shows both local and destination IDs with states, and invalidates preview on edits. A report entry includes `local_id` and, for an existing or successfully created object, `target_id`. References, exact context scope and project defaults use those maps, never a last-wins name lookup. Historical pointer-bearing documents are refused before mutation; pointer-free targets retain their stored pointers null. Labels match case-insensitively and preserve existing colors; new labels use the file's color. This remains best effort, not the atomic workflow-profile install protocol.

### Workflow export and validation HTTP

`GET /api/v1/workflows/:id/export` returns the selected workflow only, with exact state-scoped context. Query selectors are `source_project_id` (single), `schedule_id` (repeated), `tier` (repeated JSON `{state_id,tier,project_scoped?}`), and `authoring` (single JSON `{inputs,text_uses}`). Source IDs are selectors only. Unknown/foreign selections fail. Unselected schedules and all live runner/schedule metadata are excluded. Project-bound selections reserve the generated `input:destination_project` / `destination_project` declaration; authoring must not collide with it. Historical pointer-bearing documents remain inspection-only and are not exported as functional inheritance.

`POST /api/v1/library/validate` takes only `{document_json:string}` and returns `{valid,digest,document?,diagnostics,limits}`. The raw text passes strict parsing, reference/digest checks and ordinary field validators without object mutations. A missing digest may be filled here; a supplied mismatching digest fails. Semantic failure returns `valid:false` with JSON-pointer diagnostics; malformed transport envelopes use HTTP errors. Both read-only endpoints permit agent run keys. This does not grant install authority or prove destination capabilities.

### Builder checkpoint

The ordinary workflow, context/file/version, label, paused-schedule and routing builders accept typed transaction predicates and preallocated object/event IDs. Workflow creation is exact-state only; there is no inheritance phase. Guarded INSERTs are composed as INSERT SELECT before SQL compilation, and standalone callers omit these options to retain ordinary creation behavior. The foundation compiles and budgets a future guarded receipt batch, but does not ship a receipt table, install/recovery service or endpoint, or native-D1 install proof.

## Decision update — 2026-09-12 (Tines/440–441 installer delivery)

The implementation-status qualifications in “Confirmation and installation,” “Transport and transaction budgets,” and “Builder checkpoint” above describe the foundation milestone and are superseded. Tines/440 shipped the `library_install` receipt table, signed prepare/install and owner-scoped receipt endpoints, and the install service that commits the receipt and all guarded object and event writes in one atomic D1 batch. Matching retries recover the durable receipt without duplicating objects; stale destination witnesses, expired plans without a receipt, authorization failures, and failed transactions do not commit partial state.

Tines/441 added native-D1 boundary proof for an exact 800-statement commit, 801-statement rejection, injected rollback, stale and expiry guards, concurrent retry, and dropped-response recovery. The CLI now exposes this protocol through `tines workflows preview` and `tines workflows install`. The historical foundation text remains above to preserve the chronology of the format design; this update records the shipped status. The committed protocol is also summarized in [SPEC.md](SPEC.md#decision-update--tines440-workflow-package-commit).

## Decision update — 2026-09-13 (Tines/462 receipt state navigation)

New workflow-install receipt state objects use `/workflows/<workflow-id>?state=<state-id>#state-<state-id>`. The query selects and expands the state's context row, while `state-<state-id>` is the durable fragment contract retained by the workflow editor. Existing immutable receipts keep their historical hash-only URLs and remain navigable through that anchor. CLI plan validation accepts only the exact historical hash-only state URL as a compatibility form; other operation changes remain invalid.

## Hosted and cross-instance transport (Tines/436)

Public snapshots preserve the existing `profile: "workflow"` version 3 document exactly. Hosting
adds provenance and availability to signed installation plans and receipts, not to portable package
bytes. Same-host plans bind snapshot ID, document digest, byte checksum, and snapshot/publisher status
versions so the receipt transaction can reject withdrawal. Cross-instance transfer is client-side:
the source returns canonical bytes and the destination processes them as an ordinary independent
file. A destination server never fetches a supplied public URL or receives source credentials.

Tines/550 makes receipt lookup the first saved-plan recovery operation. A matching receipt returns
before the CLI classifies, resolves, checks, or reads the positional source; only a definite receipt
404 authorizes loading the exact saved source and retrying the same signed plan.

## Decision update — 2026-09-14 (Tines/484 browser-authored input edits)

The browser export authoring surface updates an authored input by its stable local ID without rebuilding the candidate. All input fields remain editable; generated inputs are read-only. A key/default change atomically rewrites only that input's active exact occurrences in fields already named by its text-use records and updates those records' canonical tokens. Escaped occurrences, unregistered fields, unrelated declarations, ordering, and candidate-only work remain unchanged. The sealed candidate must pass the ordinary v3 validator before it replaces the prior candidate; Cancel or any failure changes nothing. A successful explicit save invalidates validation and exact-content review, including when its values are unchanged.

## Decision update — 2026-09-15 (Tines/552 publication draft boundary)

Browser-authored variables and exact text edits can be published without first changing the owned
workflow. Publication submits the full sealed workflow-profile document with the clean owned export's
digest and timestamp. The publication server admits only new `input:author:` declarations, new
`use:author:` records, and text changes to workflow/context descriptions, prompt bodies, skill file
contents, and schedule title/description templates. It reconstructs from the verified baseline, so
the portable v3 format and installation substitution rules do not change.
