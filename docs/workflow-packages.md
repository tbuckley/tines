# Workflow package files

Implementation status: the foundation and CLI provide v3 whole-library transfer, workflow closure export, file validation, signed destination preparation, atomic install, durable receipt recovery, and the `tines workflows export|validate|preview|install` file workflow. The browser now authors, reviews, validates, and downloads workflow packages; browser file installation and integrated real-run acceptance remain successor work. Whole-library import remains best effort; it is not an atomic workflow installation.

## Export and validate a workflow

The CLI spelling is:

```sh
tines workflows export <workflow-id-or-unambiguous-name> > package.json
tines workflows validate package.json
```

Use `-` in place of the validation filename to read the original bytes from stdin. Export emits
only canonical package JSON to stdout, making redirection safe; errors and diagnostics use
stderr. `validate --json` returns the complete server validation object, including the sealed
document and digest, and exits 1 when `valid` is false.

Use `GET /api/v1/workflows/<workflow-id>/export`. The ID is required: multiple workflows can share a display name. Export includes complete definitions of every inheritance dependency, even Standard (as an independent bundled copy), gates, exact-state instructions and ordered prompt/skill/repo context. It preserves overridden inherited entries. Global/project/label/issue context, journals, history, credentials and runtime state are excluded. Repositories are declarations; export fetches nothing from them.

A saved file is authoritative. Later source edits do not change it. Its `sha256:` digest covers all document content and metadata except the top-level digest field, using canonical JSON. Validate edited files through `POST /api/v1/library/validate` with `{ "document_json": "<the original file text>" }`. The response contains `valid`, `digest`, `document`, `diagnostics`, and `limits`. Validating a file with an absent digest fills it; a present but mismatching digest is an error. Always pass raw file text so duplicate keys are not lost before validation. A validation result is not destination capability validation or installation approval.

### Explicit optional selections

The CLI maps these selectors directly to the API:

```sh
tines workflows export <workflow-id> \
  --project <source-project-id-or-unambiguous-name> \
  --schedule <schedule-id> --schedule <schedule-id> \
  --tier '<state-id-or-workflow/state>=balanced' --project-routing \
  --inputs authoring.json > package.json
```

`--inputs` is a JSON object with `inputs` and `text_uses` arrays. Shell arguments never perform
input substitution; destination values belong in a choices file used at preview time.

Export accepts `source_project_id=<owned ID>`, repeated `schedule_id=<ID>`, and repeated `tier=<JSON>`. Each tier selector is `{state_id:<source state ID>,tier:"smartest"|"balanced"|"cheapest",project_scoped?:boolean}`. The source project is required for selected schedules or project-scoped tiers; schedules must belong to that project and a bundled workflow. Merely selecting a project exports no schedules. Source runner IDs and live scheduling state never travel. Recurrence retains preset-or-cron intent, timezone, and follow-initial versus explicit starting state. Selected project-bound configuration automatically declares a `destination_project` input with no default. Destination selection and optional activation are separate installation concerns.

`authoring=<JSON>` can supply `{inputs:[...],text_uses:[...]}` for already-tokenized source fields. IDs in text uses refer to the exported candidate's local records, so inspect a first export before authoring declarations. `workflow:1` is the main workflow. Declared inputs substitute only the exact registered token in the exact registered field; arbitrary prose and schedule runtime tokens remain literal. For browser-local content editing and CLI file authoring, use the same portable contract rather than mutating the source workflow. See [FORMAT_V3](../specs/library/FORMAT_V3.md) and its executable examples for exact shapes, escaping and limits.

### Browser authoring and review

Open a workflow and choose **Export package**. The browser route shows the complete main and
inheritance workflow graph, gates, ordered state-scoped context, every skill file and repository
declaration, destination prerequisites, and explicitly selected automation. Source project,
schedule, and tier preferences are opt-in. Rebuilding from source warns before discarding any
candidate-only edits.

The input editor adds typed declarations and registers an exact token at the selected range of one
editable candidate field. It never searches and replaces matching prose, edits the private source,
or recursively expands a destination value. Token buttons return to their declaration and Escape
returns focus to the passage. Required skill and repository declarations must each be reviewed
again after a candidate change. **Validate & download** sends the exact candidate through the
shared validator and downloads the same canonical JSON bytes emitted by the CLI. The page fetches
neither repositories nor other external package dependencies, and download does not install or
publish anything.

## Whole-library backups and transfer

Settings → Export / import downloads v3 `profile:library` files. These also contain ambient scopes, projects, labels and optional journals. Review sensitive prompt and skill contents before sharing. On import, every workflow has a local-ID mapping row. Choose an existing workflow by destination ID or create an independently named workflow. Duplicate source names remain distinct in an empty destination; collisions with ambiguous existing names require explicit choices. Settings proposes unused renamed creates. The preview resets whenever a choice changes.

The whole-library endpoint retains v1/v2 readers; `GET /api/v1/export?version=2` explicitly requests a compatibility export for an older deployment. Older name-based files cannot disambiguate duplicate workflows or ambiguous slash-based state references and are refused truthfully. Compatible inheritance updates require overwrite; v1 files never compare or clear a destination pointer. A refused structural overwrite leaves existing target states available. Import is best effort and reports each create/skip/overwrite/refusal/error. Existing project defaults and existing label colors stay unchanged.

## Prepare a destination review

```sh
tines workflows preview package.json --choices choices.json --plan-out package.plan.json
```

Human output includes every create/reuse/skip operation, the workflow graph and artifact gates,
input resolutions, original and rendered text, complete prompt/skill-file/repository contents,
schedules, routing capabilities, runner/model/configuration details, and compiled budget. Add
`--json` for the complete structured response. The atomically written plan file records the
normalized API base, document and plan digests, full review, allocation, expiry, and signed
token. It deliberately does not record the API key. Treat the token as temporary authorization
material and do not share the plan file.

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
requires a human session or named key to re-prepare as that actor.

## Install and recover

```sh
# Automation / non-TTY: both values must come from the separate review above.
tines workflows install package.json --plan package.plan.json \
  --confirm 'sha256:<exact-plan-digest>'

# At a terminal: prepares, persists package.json.plan.json, shows the full review, then asks.
tines workflows install package.json --choices choices.json
```

There is no `--yes`. Non-TTY use requires both a prior saved plan and the exact plan digest;
decline, EOF, a wrong digest, a changed package, a different API base, and a run key all stop
before the install POST. `-` package input cannot double as an interactive confirmation stream;
save a plan first. A plan cannot be combined with new choices because its signed choices are
authoritative.

On retry the CLI checks `GET /api/v1/library/installs/<plan_id>` first. If no receipt exists it
submits the saved token again; after a transport-uncertain response it checks the receipt and
retries only that same request. It never silently prepares a replacement. Expired, stale, or
tampered plans remain errors; preview again explicitly if you want a different plan. Two-account
transfer therefore means exporting under the source account, then validating, previewing, and
installing under the destination account/API base with explicit destination IDs in the choices
file.

Commit the reviewed plan with `POST /api/v1/library/install`, sending the same
`document_json` and `plan_token` plus
`confirmation: {"plan_digest":"<the exact reviewed digest>"}`. The server
revalidates the signature, actor, file, choices, allocation, destination witness
and transaction-time expiry, then creates the complete independent copy in one
atomic batch. Selected schedules are paused with a zero run count. Installation
does not create an issue, dispatch work, or change a project default.

Success returns an immutable receipt linking every created object and naming
reused inputs without retaining package prose, input text, credentials or the
token. Retrying the identical request returns that receipt, including after plan
expiry. Recover it separately with `GET /api/v1/library/installs/<plan_id>`;
owner access survives API-key rotation. A missing receipt after a possibly lost
response is not proof of rollback—retry the same signed request. Run keys may
read an owner receipt but cannot commit an installation.

## Native D1 verification

`apps/web/e2e/native-install.spec.ts` is the release gate for behavior that a
Node SQLite fixture cannot prove. It boots the built Worker against a fresh
Wrangler D1 database, applies the repository migrations and triggers, drives
the public prepare/install/recovery endpoints, and audits durable rows with
Wrangler. Temporary database triggers inject failures without exposing any
test-only application endpoint or production switch.

Run it from the repository root:

```sh
E2E_PORT=8791 pnpm --filter web exec playwright test e2e/native-install.spec.ts
```

The gate submits the complete 800-statement compiled batch and proves exact
receipt-to-row mappings and one-copy counts for every object and event family.
The 801-statement case is rejected by preparation before any write. It injects
native failures into workflow, state, transition, context, file,
inherited-pointer, label, schedule, routing, and event phases and verifies full
rollback and unchanged issues/project defaults. It also exercises stale
destination guards, transaction-time expiry, old-nonce child guards, a truly
concurrent first commit, socket-level discarded-response recovery, and
sequential retries.

A separate test-only Wrangler Worker probes the D1 binding without going
through application validation. Wrangler's local D1 enforces 100 parameters
and 100,000 UTF-8 SQL bytes per statement; 101 and 100,001 are rejected. It
accepts the application's 1 MiB value boundary and one byte beyond. Local
Workerd does not currently reproduce hosted D1's documented 2,000,000-byte
row/value rejection (it accepted 2,000,001 bytes), so the hosted limit remains
normative rather than being mislabeled as locally observed. The conservative
application limits remain 800 statements, 90 bound parameters and 90 KiB of
UTF-8 SQL per statement, 1 MiB per stored value, 5 MiB per document, and 1,000
portable records. The smaller document, prompt, skill, and field limits still
apply before compilation.
