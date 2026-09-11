# Tines — Library export / import

The **library** is the reusable half of a deployment: the workflows you own
plus every context item that is not tied to a single issue. `GET
/api/v1/export` writes it as one JSON document and `POST /api/v1/import`
reads one back, so a library moves between deployments that share no ids.

Implemented by `apps/web/src/lib/server/api/library.ts`, typed in
`packages/shared/src/types.ts` (`LibraryDocument`), surfaced at
Settings → Export / import.

## The document

```jsonc
{
  "format": "tines.library",
  "version": 2,
  "exported_at": 1788000000000,
  "projects": [{ "name": "Tines", "default_workflow": "Engineering" }],
  "workflows": [ /* CreateWorkflowRequest, verbatim */ ],
  "context": [ /* CreateContextItemRequest bar its scope */ ]
}
```

Two rules hold the whole format together:

- **Everything is referenced by name, never by id.** A context item's scope is
  a `LibraryScopeRef` (`project`, `state: { workflow, name }`, `label`); a
  project's default workflow is a workflow name; a state's inheritance pointer
  is `"<workflow name>/<state name>"`.
- **Each entry is already a valid create request**, so import is a
  pass-through into `createWorkflow` / `createProject` / `createContextItem`
  rather than a second implementation of their validation.

The system `Standard` workflow is never exported — it is seeded with identical
ids on every instance — but items scoped to its states are, and re-resolve by
name, as does an inheritance pointer at one of its states.

Excluded on purpose: issues, comments, events, runs, schedules, artifacts,
runner/supervisor configuration, and every credential.

### States

A `workflows[].states[]` entry carries `name` and `category`; array order
carries `position`. `prompt` is not used — stage instructions travel as
ordinary state-scoped context items in `context`.

`inherits_from` (version 2 and up) is the state whose context this state
inherits (Tines/238), named as `"<workflow name>/<state name>"` on both sides
of the trip. A state with no base carries no key at all, which is what keeps a
deployment with no pointers exporting the same document it did under version
1. Both halves of the ref are free-form names that may themselves contain a
slash, so a reader tries each split point and takes the one that names a real
state.

Import resolves a pointer in this order: a state in the same workflow (the
create path already resolves those by name), then a state this deployment
already has, then — for a base that a workflow *later in the same document*
brings — a second pass that patches the pointer on through the normal workflow
update once every workflow exists. Document order therefore does not matter.
A pointer whose base is neither in the document nor on the deployment
**refuses that workflow's plan entry**, naming the base as `<workflow> /
<state>`: creating it with the pointer silently dropped would import stages
that look right and inherit nothing. A refusal can strand that workflow's own
children, so the check runs to a fixpoint, and it happens during planning —
a dry run lists it before anything is written. The API's own `inheritance_*`
refusals (depth, cycles) pass through as the entry's error.

A workflow the deployment already has under the same name is matched on
structure alone — the fingerprint covers states, transitions and artifact
requirements, deliberately not inheritance, which is edited independently of
the shape. So the two can be structurally identical and still disagree on
their pointers, which is exactly what a deployment holding an earlier version
1 export of the same library looks like. That case is **not** "identical": the
entry names the states that differ and is refused, or, with `on_collision`
set to `overwrite`, updates just those pointers on the existing workflow
(states re-sent by id, a state the document gives no base cleared) and leaves
everything else untouched. The read-only `Standard` workflow is always
refused.

## Version history

`LIBRARY_VERSION` is bumped when the document shape changes; import refuses a
document from the future and reads every older version.

| Version | Change                                                                     |
| ------- | -------------------------------------------------------------------------- |
| 1       | Projects, workflows (states, transitions, artifact requirements), context.  |
| 2       | `states[].inherits_from` — the state inheritance pointer, by name (Tines/270). |

## Import semantics

`POST /api/v1/import` plans first and applies the same plan: `dry_run` returns
exactly the entries the confirm would run, each `create` / `skip` /
`overwrite` / `refuse` / `error` with a reason. Projects and workflows are
matched by name (a structurally identical workflow is skipped, a different one
under the same name is refused, and one that differs only in its inheritance
pointers is refused unless `on_collision` is `overwrite`); context items are
matched on the
`context_item_name_scope_uq` tuple and skipped unless `on_collision` is
`overwrite`. Labels are the one thing an import creates to carry a scope —
they hold nothing but a name. A failing entry is reported and the rest
proceeds, so re-running a partial import converges.

Starters (`specs/starters/SPEC.md`) are library documents with typed inputs
bolted on; they apply through their own single-batch path, not through import.

## Decision update — Tines/435 whole-library v3

Whole-library export now defaults to the ID-addressed v3 `profile: library` contract in [FORMAT_V3.md](FORMAT_V3.md). `GET /api/v1/export?version=2` remains an explicit compatibility export, and v1/v2 imports retain their best-effort behavior. The older name-based design above remains the historical v1/v2 record.

V3 import maps document-local workflow IDs independently. With no destination collision, duplicate source names remain distinct workflows. Unique-name collisions retain skip/compatible-inheritance-overwrite behavior. Ambiguous collisions require `workflow_targets[local_id] = {kind:"target",workflow_id}` or `{kind:"create",name}`. Settings proposes independently renamed creates and displays each source ID and its states; target choices display destination IDs and states. Multiple source workflows cannot target one destination. All state pointers, prompts and project defaults follow the chosen IDs. Structure mismatches refuse replacement while preserving existing target states for scoped context. Label records preserve colors on creation; existing labels and project defaults stay unchanged.

Preview and apply share one planner and ordinary validators. Edits invalidate the browser preview. Whole-library transfer remains best effort, with per-entry failures; it does not offer the separately specified workflow-package atomic install guarantee. Raw JSON envelope decoding rejects duplicate keys and invalid UTF-8 before conversion to objects. The request is bounded to 32 MiB, and its document independently to 5 MiB.

## Decision update — Tines/440 workflow-package commit

Workflow-profile v3 files use a signed prepare → install protocol. `POST /api/v1/library/install` confirms the exact plan digest and commits one guarded D1 batch whose first row is an immutable owner receipt; every child write and event is gated by that attempt's fresh execution nonce. Identical retries recover the committed receipt before expiry/compiler checks, while actor, file, confirmation and request mismatches never replay it. `GET /api/v1/library/installs/:planId` is owner-scoped and remains usable after API-key rotation. Run keys retain export, validation, preparation and receipt reads but are denied installation at both the route fence and service boundary. Schedules install paused, and the commit creates no initial issue, dispatch, or project-default mutation. Native-D1 capacity and concurrency boundary evidence remains the responsibility of Tines/441.
