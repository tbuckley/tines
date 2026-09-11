# Workflow package files

Implementation status: the foundation provides v3 whole-library transfer, workflow closure export, file validation, and signed read-only destination preparation. Atomic install/receipt recovery, workflow CLI commands, browser package authoring/install, and real-run acceptance are planned successor work. Whole-library import remains best effort; it is not an atomic workflow installation.

## Export and validate a workflow

Use `GET /api/v1/workflows/<workflow-id>/export`. The ID is required: multiple workflows can share a display name. Export includes complete definitions of every inheritance dependency, even Standard (as an independent bundled copy), gates, exact-state instructions and ordered prompt/skill/repo context. It preserves overridden inherited entries. Global/project/label/issue context, journals, history, credentials and runtime state are excluded. Repositories are declarations; export fetches nothing from them.

A saved file is authoritative. Later source edits do not change it. Its `sha256:` digest covers all document content and metadata except the top-level digest field, using canonical JSON. Validate edited files through `POST /api/v1/library/validate` with `{ "document_json": "<the original file text>" }`. The response contains `valid`, `digest`, `document`, `diagnostics`, and `limits`. Validating a file with an absent digest fills it; a present but mismatching digest is an error. Always pass raw file text so duplicate keys are not lost before validation. A validation result is not destination capability validation or installation approval.

### Explicit optional selections

Export accepts `source_project_id=<owned ID>`, repeated `schedule_id=<ID>`, and repeated `tier=<JSON>`. Each tier selector is `{state_id:<source state ID>,tier:"smartest"|"balanced"|"cheapest",project_scoped?:boolean}`. The source project is required for selected schedules or project-scoped tiers; schedules must belong to that project and a bundled workflow. Merely selecting a project exports no schedules. Source runner IDs and live scheduling state never travel. Recurrence retains preset-or-cron intent, timezone, and follow-initial versus explicit starting state. Selected project-bound configuration automatically declares a `destination_project` input with no default. Destination selection and optional activation are separate installation concerns.

`authoring=<JSON>` can supply `{inputs:[...],text_uses:[...]}` for already-tokenized source fields. IDs in text uses refer to the exported candidate's local records, so inspect a first export before authoring declarations. `workflow:1` is the main workflow. Declared inputs substitute only the exact registered token in the exact registered field; arbitrary prose and schedule runtime tokens remain literal. For browser-local content editing and CLI file authoring, use the same portable contract rather than mutating the source workflow. See [FORMAT_V3](../specs/library/FORMAT_V3.md) and its executable examples for exact shapes, escaping and limits.

## Whole-library backups and transfer

Settings → Export / import downloads v3 `profile:library` files. These also contain ambient scopes, projects, labels and optional journals. Review sensitive prompt and skill contents before sharing. On import, every workflow has a local-ID mapping row. Choose an existing workflow by destination ID or create an independently named workflow. Duplicate source names remain distinct in an empty destination; collisions with ambiguous existing names require explicit choices. Settings proposes unused renamed creates. The preview resets whenever a choice changes.

The whole-library endpoint retains v1/v2 readers; `GET /api/v1/export?version=2` explicitly requests a compatibility export for an older deployment. Older name-based files cannot disambiguate duplicate workflows or ambiguous slash-based state references and are refused truthfully. Compatible inheritance updates require overwrite; v1 files never compare or clear a destination pointer. A refused structural overwrite leaves existing target states available. Import is best effort and reports each create/skip/overwrite/refusal/error. Existing project defaults and existing label colors stay unchanged.

## Prepare a destination review

Send the original digest-bearing file text to `POST /api/v1/library/prepare`:

```json
{
  "document_json": "<the original file text>",
  "choices": {
    "workflow_names": { "workflow:1": "My review workflow" },
    "inputs": { "input:1": { "mode": "create", "name": "qa", "color": "blue" } },
    "schedule_ids": [],
    "routing": {}
  }
}
```

All maps use document-local IDs. Text choices use `{value:"..."}`; existing
workflow/project/label choices use `{mode:"reuse",id:"<destination ID>"}`.
Only labels allow explicit create choices. Object defaults are name suggestions;
an ambiguous default requires an explicit destination ID. Dependencies always
become independent copies. Missing workflow collision choices receive deterministic
`(imported)` suffix proposals; explicit colliding names fail. `schedule_names`
selects final names per selected schedule. `routing` maps selected preference IDs
to actual destination tiers. Unselected schedules/routing are reported as skipped;
no project is required for omitted project-bound automation.

The result includes the complete original document, resolved definitions and
inputs, original/rendered field patches, IDs, skipped optional records, destination
runner/model/configuration review, and exact compiled-batch sizes. Its 15-minute
`plan_token` binds the actor, file digest, choices, allocation and relevant durable
destination data. Changing anything requires a fresh review. Runner heartbeats and
unrelated account edits do not stale a plan. Preparation creates no objects,
schedules, issues or receipt. Run keys may prepare, but the eventual installer
requires a human session or named key to re-prepare as that actor. Install and
receipt recovery are planned successor work; do not treat a token as a completed
installation or actual-run evidence.
