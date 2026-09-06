# Tines — Issue Artifacts Spec

> Extends the context system ([../context/SPEC.md](../context/SPEC.md)) with a
> fourth kind, and the workflow system with the first transition gating
> mechanism.

Context tells an agent *how* to work; artifacts are the **work products
attached along the way** — a design document, a screenshot of the feature, a
research note, the pull request that implements it. This spec adds
**artifacts**: named, typed, versioned attachments on issues, and **transition
requirements**: workflow transitions that demand a fresh artifact before they
can be taken. The motivating loop: *design → implementation* requires a
`design-doc` artifact; bouncing back to *design* makes the old doc stale, so a
new version must be attached before *implementation* is reachable again.

Artifacts are context items of a new kind, so they inherit the context
system's identity, naming, events, and listing for free — but they are
deliberately **not part of the effective context**: nothing is stitched into
the prompt, nothing is seeded into a workspace. Agents see that artifacts
exist (in the launch prompt's issue block) and fetch content on demand.

## Goals

- Attach typed artifacts to issues: uploaded **files** (including images),
  inline **text** documents, **links**, **PR** references, and **folders** —
  multi-file trees uploaded as one snapshot (a set of screenshots, a rendered
  report with its assets).
- Keep an immutable **version history** per artifact — attaching "a new design
  doc" is a new version of the same named artifact, and the pre-redesign
  version remains inspectable.
- Declare **requirements on workflow transitions**: "this transition needs a
  fresh artifact named *X* (optionally of type/content-type *Y*)", enforced at
  the transition API with a structured, self-correcting error.
- **Freshness by timestamp**: a requirement is satisfied only by an artifact
  version created at or after the issue last entered its current state — so
  re-entering *design* automatically invalidates the old doc with no mutation
  machinery.
- Preview common artifact types in the web UI: rendered Markdown, inline
  images, text; links and PRs as outbound cards.
- Let agents attach artifacts and satisfy their own gates via the CLI/API —
  gates assert *the artifact exists and is fresh*, not *a human did it*
  (human sign-off remains what `awaiting_human` states are for).

## Non-goals

- **Incremental folder writes**: a folder version is always uploaded whole
  (one snapshot per version). Per-file add/replace endpoints that derive a
  new version from the current set were considered and rejected — they
  reintroduce a mutable in-between state, and "adding one file blesses the
  stale rest" muddies freshness. Agents collect locally and attach once.
- **Server-side archive handling**: no zip upload/explode; the folder upload
  is one multipart request with the files as parts.
- **Server-side thumbnailing**: image previews load the original bytes
  (lazily); screenshots are small enough. Revisit if originals outgrow it.
- **PR status integration**: a `pr` artifact stores the reference only. No
  fetching of open/merged/CI state (that would use the stored GitHub PAT and
  can layer on later); no gate on "PR is merged".
- **Workspace delivery**: artifacts are never seeded into agent workspaces and
  never inlined into prompts. `tines issues context --out` is unchanged.
- **Storage quotas and version pruning**: per-file and per-artifact caps ship;
  a global per-user quota and old-version expiry are future work.
- **Cross-issue or broader-scoped artifacts**: artifacts are issue-scoped
  only. Project- or state-scoped attachments have no use case yet and the
  requirement semantics don't want them.
- **Deleting individual versions**: history is immutable; delete the whole
  artifact or nothing (v1).

## Concepts

### Artifact = context item of kind `artifact`

An artifact is a `context_item` with `kind = 'artifact'`, which buys identity,
per-scope name uniqueness, `position`, timestamps, `context.*` events, and the
Context tab listing without new machinery. Constraints specific to the kind:

- **Scope**: exactly the issue dimension — `issue_id` set, `project_id` and
  `workflow_state_id` null (the coherent-but-redundant `issue ∧ project` form
  is normalized down to issue-only at create time). Any other scope is a 422
  `artifact_scope_invalid`. This is a validation restriction inside the
  artifact validator, not a change to scope machinery.
- **Name**: slug-like (`[a-z0-9-]+`, ≤ 100 chars — the skill-name rule),
  because the name is the requirement-matching key and appears in CLI
  commands. Unique per issue among artifacts (the existing
  name-per-kind-per-exact-scope rule).
- **Artifact type**: `file`, `text`, `link`, `pr`, or `folder` — stored in
  the item's JSON `config` column (this kind introduces the `config` column
  the context spec reserved). The type is immutable after creation, like
  `kind` itself: a slot named `design-doc` doesn't change species between
  versions.
- **Description**: the usual optional one-liner; shown in lists and in the
  launch prompt's artifact listing.

Artifacts are **excluded from the effective context**: they contribute nothing
to the stitched prompt, `skills`, `repos`, dedupe, or `--out`. They surface
through their own endpoints, the issue page's Artifacts panel, and the launch
prompt's issue block (below). `context_summary` gains an `artifacts` count so
the issue read can badge them.

Creation and payload mutation go through dedicated artifact endpoints only —
`POST /api/v1/context` with `kind: "artifact"` is a 422
(`use_artifact_endpoints`) because file payloads can't ride a JSON create, and
one creation path is saner than two. That 422 names every write endpoint —
the JSON upsert, `…/:name/file`, and `…/:name/folder` — in its message and
again in `details.endpoints` (`method`, `path`, `types`, `accepts`), so the
redirect stays complete as artifact types are added. The generic context
endpoints still **read** artifact items (list/show, payload summarized),
still **PATCH** name/description (rename re-keys requirement matching, which
is the point), and still **DELETE** them.

### Versions

Every artifact has ≥ 1 immutable versions, numbered from 1. Attaching content
to an existing name appends the next version; nothing is overwritten. Each
version records its payload, who attached it (the standard actor pair:
user or API key, run keys included), and `created_at` — the timestamp that
freshness reads.

Per-type version payloads:

- **`file`** — uploaded bytes stored in R2. Metadata in D1: `filename`
  (display name, validated like workspace paths — no `/` needed though, it's
  a basename), declared `content_type` (MIME), `size_bytes`, and the R2 key.
  Cap: **25 MB** per file.
- **`text`** — inline document stored in D1 (`content`), optional `filename`
  (defaults to `<name>.md`), `content_type` defaulting to `text/markdown`.
  Cap: **256 KB**. This is the "agent writes a design doc without touching
  multipart anything" path.
- **`link`** — a URL (`http(s)` only), optional `title`.
- **`pr`** — a repository URL (canonicalized like `github_repository` session
  resources: `https://github.com/{owner}/{repo}`) plus a PR number. The API
  also accepts a full PR URL (`…/pull/123`) and splits it.
- **`folder`** — a multi-file tree uploaded as **one immutable snapshot**:
  the version row plus one child row per file (`path`, declared
  `content_type`, `size_bytes`, R2 key), sharing the version's single
  `created_at`. Mixed file types and subfolders are supported; paths follow
  the workspace-path rules (forward slashes, no `.`/`..`, no `\` or `=`;
  additionally no `"`, which multipart filenames can't carry reliably).
  Caps: **200 files** and **50 MB total** per version (per-part bytes also
  bounded by the 25 MB file cap) — the totals keep the buffered multipart
  parse well inside Worker memory; streaming/presigned uploads are the
  revisit trigger for raising them. A new snapshot is the only way to change
  the set — see Non-goals.

  Folders exist for bundle-shaped work products, and for evidence gated by a
  workflow that is **generic over issues**: a transition can require the
  conventional slot `screenshots` while each issue's set contains whatever
  surfaces that feature has. The rule of thumb (agents get it in the attach
  errors and docs): does a reviewer care how one file evolves across rounds,
  and is it produced incrementally? Then use sibling `file` artifacts. Is
  the set consumed whole and produced whole? Folder.

A version-adding write emits `context.updated` with a summary payload
(`{version, artifact_type, filename?, size_bytes?}`) — no new event types.
A metadata-only edit (description via PATCH, or an upsert carrying no payload
fields) does **not** create a version and does not refresh freshness.

**Reaffirming.** "This artifact still stands" is a first-class action: a
reaffirm appends a new version that **reuses the previous current version's
payload** — same content, same R2 object(s) (a folder reaffirm copies the
file rows, referencing the same objects), no bytes move. It is a real version
row (new `created_at`, the reaffirming actor, `reaffirmed_from` pointing at
the source version number), so freshness stays one rule, the actor trail
shows who blessed the content and when, and history reads "v3 — reaffirmed
v2". It counts against the version cap and emits `context.updated` with
`{version, reaffirmed_from}`. Reaffirming is deliberately open to run keys:
an agent could always re-upload identical bytes, so gating reaffirmation
would only add ceremony — requirements assert freshness, and human blessing
belongs to `awaiting_human` states.

Versions per artifact are capped at **50** (422 `artifact_version_limit`,
suggesting deletion of the artifact if the history is truly disposable).

### Freshness

**An artifact version is *fresh* iff `version.created_at ≥
issue.state_entered_at`** — the moment the issue last entered its current
state. Nothing is mutated on transition; staleness is derived. For folders
the granularity is the **set**: a version is one snapshot with one
timestamp, so "fresh" means "this round produced (or reaffirmed) this set"
— there is no per-file freshness, by construction. Consequences:

- First pass through *design*: attach the doc while in *design* → fresh →
  the gated transition passes.
- Later, *implementation → design* (send back): `state_entered_at` advances,
  the old version is now stale, and *design → implementation* is blocked until
  a new version is attached. Exactly the motivating rule, with zero
  invalidation machinery.
- Edge, by design: an artifact attached **before** the issue entered the
  gating state (say, during *backlog*) counts stale for a transition out of
  *design*. The gate reads "the current round of design produced/blessed
  this"; **reaffirming** (one click / one command, see Versions) or attaching
  a new version is the explicit blessing. The UI and error payload both show
  *stale since* timestamps so this is never mysterious. A
  first-entry-grandfathers variant was rejected: it needs entry-history
  tracking and makes the rule harder to state, while reaffirm makes the
  strict rule cheap to live with.

`state_entered_at` is a new column on `issue`, stamped `now` by **every** path
that changes `state_id`: `transitionIssue`, the forced `state` set in
`updateIssue`, and a `workflow_id` change (which re-seats the state). Existing
rows backfill with `created_at` — deliberately permissive, so pre-existing
attachments don't all wake up stale. Deriving entry time from
`issue.transitioned` events was rejected: JSON event mining in queries is
fragile, and a column stamped at the single write choke points is exact.

### Transition requirements

A workflow transition may declare requirements, stored as a JSON array in a
new `requirements` column on `workflow_transition` (null/absent = none —
the sanctioned JSON-column shape; no child table, since requirements have no
per-row identity and are edited wholesale with the workflow definition):

```jsonc
[
  {
    "artifact": "design-doc",          // required slot name (slug)
    "type": "file",                    // optional: file | text | link | pr
    "content_type": "text/markdown",   // optional prefix match, file/text only
    "description": "The approved design document for this round"
  }
]
```

- `artifact` is the slot name a matching artifact must carry.
- `type`, when set, must equal the artifact's type.
- `content_type`, when set, prefix-matches the **current version's** declared
  content type (`"image/"` matches any image; only meaningful with
  type `file` or `text` — 422 at definition time otherwise, `folder`
  included: with mixed-type trees there is no honest all-files/any-file
  semantics, so a folder requirement asserts the slot and its type only;
  what belongs inside is prose for the stage instructions).
- `description` is human/agent-facing: shown in the workflow editor, the
  transition UI, the launch prompt, and the unmet-requirement error.

Requirements are part of the workflow definition: declared inline on
`WorkflowTransitionInput` (`{name, from, to, requires?}`), validated in
`resolveDef` (slug names, known types, no duplicate slot names per
transition), and re-created wholesale with the transitions on every
whole-workflow PATCH — which is why nothing keys on `workflow_transition.id`.
The system workflow `wf_standard` ships without requirements and remains
read-only.

**A requirement is satisfied** for issue *I* taking transition *T* iff an
artifact exists on *I* with the slot name, matching `type` and `content_type`
where set, whose current version is fresh (per above). Otherwise its status is
`missing`, `type_mismatch`, or `stale`.

### Enforcement

`transitionIssue` checks requirements **after** resolving the target
transition and **before** the compare-and-swap write. Any unmet requirement is
a 422 in the `invalid_transition` recovery style:

```jsonc
{
  "error": {
    "code": "transition_requirements_unmet",
    "message": "Transition \"approve\" requires a fresh artifact \"design-doc\" (text/markdown).",
    "details": {
      "transition": { "name": "approve", "to_state": "Implementation" },
      "state_entered_at": 1724900000000,
      "unmet": [
        {
          "artifact": "design-doc",
          "type": "file",
          "content_type": "text/markdown",
          "description": "The approved design document for this round",
          "status": "stale",                       // or "missing" | "type_mismatch"
          "current_version": { "version": 2, "created_at": 1724800000000 }
        }
      ]
    }
  }
}
```

The message names the fix, and `details` carries everything an agent needs to
self-correct: attach the named artifact (`missing`), or attach a new version
/ reaffirm (`stale`), then retry the same transition. The check and the CAS are not atomic (an artifact could be deleted
between them); that race window is accepted — the gate is a process guard, not
a security boundary, and the force path below exists anyway.

**Pre-flight visibility.** `AllowedTransition` gains a `requires` array — each
requirement with its live `status` — so the issue page can annotate/disable
transition buttons before anyone clicks, and the launch prompt can tell an
agent what a move needs *before* it tries. Computed in `getIssueDetail`
alongside the existing loads (a handful of rows per issue; cheap).

**The escape hatch stays, humans only.** The forced `state` set on
`PATCH /api/v1/issues/:id` continues to bypass transition validation,
requirements included (that is what an escape hatch is for; it already records
`forced: true`). But **run keys are denied the `state` and `workflow_id`
fields** (403, the `assertPinFieldsAllowed` field-guard pattern) — an agent
cannot route around its own gate. Everything else about the run-key fence is
unchanged: artifact read/write endpoints are *not* control-plane (agents
attach artifacts as a matter of course), while workflow definitions — where
requirements live — already are.

### Launch prompt

The issue block gains an **Artifacts** section between *Comments* and
*Available transitions* — a listing, never contents:

```markdown
### Artifacts

- **design-doc** (file, text/markdown, v3, fresh) — The approved design document
  Fetch: `tines issues artifacts get <project>/<number> design-doc --out .`
- **screenshots** (folder, 4 files, v2, fresh) — This round's UI evidence
  Fetch: `tines issues artifacts get <project>/<number> screenshots --out .`
- **feature-screenshot** (file, image/png, v1, attached before current state)
- **impl-pr** (pr) — https://github.com/acme/app/pull/123

*("No artifacts attached." when empty. The section ends with:
Attach one: `tines issues artifacts attach <project>/<number> <name> …` — the
flag follows the gate; each gated transition below names its exact command.
Ungated slots: --file <path>, --folder <dir>, --text <md|@file>, --link <url>,
--pr <owner/repo#N>.)*
```

And each entry under *Available transitions* appends its requirements with
live status, so the prompt alone tells an agent both its legal moves and their
preconditions. An **unsatisfied** requirement ends in the command that clears
it — the same `fix` string the 422 and the issue read carry:

```markdown
- **approve** → Implementation (active): `tines issues move tines/42 "approve"`
  Requires: artifact `design-doc` (text, text/markdown) — **stale; attach a new version (or reaffirm) first** — attach: `tines issues artifacts attach tines/42 design-doc --text @design-doc.md — or, if the current content still stands: tines issues artifacts reaffirm tines/42 design-doc`
```

**One source for every attach hint** (Tines/241). `requirementFix` in
`@tines/shared` maps an `ArtifactRequirementCheck` plus the issue ref to a
runnable command and a `kind` (`attach` / `reattach_or_reaffirm` /
`delete_and_attach`). `checkRequirements` calls it once per requirement, so
`fix` is a **required field on every** `ArtifactRequirementCheck` — satisfied
ones included, where it is the command that attaches the next version — and
therefore rides `allowed_transitions[].requires[]` on
`GET /api/v1/issues/:id`, the launch prompt's `Requires:` lines, and the 422's
`unmet[]`, byte-identical in all three. The flag follows the gate: a
`(text, text/markdown)` requirement renders `--text @<slot>.md`, a `text/plain`
one `@<slot>.txt`, and anything less concrete keeps the
`--text <markdown|@file>` placeholder. Nothing privileges `--file` any more —
naming it first in the generic hint taught agents to reach for it under gates
that wanted something else.

The `transition_requirements_unmet` 422 summary follows the same `kind`: a
`delete_and_attach` (the slot holds the wrong **immutable** type) says so —
*the attached "spec" is a link artifact and the gate needs text* — instead of
the generic "attach it (or a new version)", which would send an agent round
the identical 422. `missing` and `stale` keep that wording. The CLI's own pre-flight refusals quote
the same `fix` verbatim rather than composing a second wording, and `issues
show` renders it beside the requirement, so the hint an agent reads before it
attaches and the one it reads after a blocked `move` are the same string.

### Events, lifecycle

- Artifact create / new version / metadata edit / delete emit the existing
  `context.created` / `context.updated` / `context.deleted` with
  `kind: "artifact"` — feeds, actor attribution, and issue/project references
  all come from the context event machinery untouched.
- Blocked transitions (4xx) emit nothing, like all rejected writes.
- Lifecycle guards are inherited: artifacts are issue-scoped and issues cannot
  be deleted in this phase, so `force_delete_context` sweeps never encounter
  them. When issue deletion arrives, artifact R2 objects join that story.
- Deleting an artifact deletes its D1 rows in the transactional batch, then
  best-effort deletes its R2 objects (see Storage). Removing a *requirement*
  from a workflow touches no artifacts — attachments outlive the gates that
  once demanded them.

## Data model (D1 / Kysely)

```
context_item          + config TEXT              -- JSON; artifact: {"artifact_type": "file"}
                                                 -- (the column reserved by the context spec)

artifact_version      id            TEXT PK      -- av_…
                      context_item_id TEXT NOT NULL REFERENCES context_item(id) ON DELETE CASCADE
                      version       INTEGER NOT NULL          -- 1..N, UNIQUE(context_item_id, version)
                      filename      TEXT,        -- file/text
                      content_type  TEXT,        -- file/text (declared MIME)
                      size_bytes    INTEGER,     -- file
                      r2_key        TEXT,        -- file; opaque, never exposed
                      content       TEXT,        -- text
                      url           TEXT,        -- link
                      pr_repo_url   TEXT,        -- pr (canonical https://github.com/{o}/{r})
                      pr_number     INTEGER,     -- pr
                      reaffirmed_from INTEGER,   -- version number this reaffirms, when a reaffirm
                      actor_user_id TEXT, actor_api_key_id TEXT,
                      created_at    INTEGER NOT NULL
                      -- index on (context_item_id, version DESC) for current-version reads

artifact_version_file id            TEXT PK      -- avf_…; folder versions only
                      artifact_version_id TEXT NOT NULL REFERENCES artifact_version(id) ON DELETE CASCADE
                      path          TEXT NOT NULL -- workspace-relative, UNIQUE(artifact_version_id, path)
                      content_type  TEXT NOT NULL -- declared MIME
                      size_bytes    INTEGER NOT NULL
                      r2_key        TEXT NOT NULL -- opaque, never exposed

workflow_transition   + requirements TEXT        -- JSON array; NULL = none

issue                 + state_entered_at INTEGER -- stamped on every state_id change;
                                                 -- backfilled with created_at
```

Migration `0011_issue_artifacts.sql`: three `ALTER TABLE ADD COLUMN`s, one
`CREATE TABLE`, one backfill `UPDATE`; `0012_artifact_folders.sql` adds the
`artifact_version_file` table — all plain SQL executable by
`node:sqlite`, so the unit-test harness picks it up automatically. Per-type
payload validation is API-layer (the `KIND_FIELDS`-style trade the context
system already makes), with a `TYPE_FIELDS` map inside the artifact validator
rejecting foreign payload fields per artifact type
(`artifact_payload_mismatch`).

## Storage (R2)

The first binary storage in the system:

- New R2 binding **`ARTIFACTS`** in `wrangler.jsonc` (bucket
  `tines-artifacts`; `tines-artifacts-preview` in the `preview` env — both
  the root and `env.preview` blocks), plus the `Env` field in `app.d.ts`.
- **Keys**: `art/{user_id}/{context_item_id}/{version_id}` for `file`
  versions and `art/{user_id}/{context_item_id}/{version_id}/{file_id}` for
  folder entries — immutable, one object per uploaded file, never
  overwritten (a reaffirming version stores no new objects; its rows carry
  the reaffirmed version's keys, which is safe because deletion is
  whole-artifact only — a prefix delete on the item covers every version's
  objects). Keys are internal; every byte in and out is proxied through the
  Worker (no presigned URLs — they'd need account-level S3 credentials, and
  the Worker proxy keeps auth in one place).
- **Write order**: R2 object(s) first, then the D1 batch (item/version/file
  rows + event). If D1 fails — or a folder upload dies partway through its
  objects — orphaned R2 objects are the failure mode: invisible and cheap; a
  periodic orphan sweep is future work. Never the reverse: no D1 row may
  reference a missing object.
- **Delete order**: D1 batch first, then best-effort R2 deletes. Same
  invariant.
- **File uploads** are single-shot raw-body requests (the first non-JSON
  endpoint): the browser and CLI both send bytes with `Content-Type` and
  `Content-Length` (required; ≤ 25 MB enforced before write). **Folder
  uploads** are one `multipart/form-data` request (the second): one part per
  file, the workspace-relative path as the part's filename and the declared
  MIME as the part's content type — chosen over zip-and-explode (no archive
  handling in the Worker, per-file objects fall out naturally) and over
  staged per-file writes (see Non-goals). Field names are ignored; caps are
  enforced after the parse, before any object is written. Multipart
  mutations trip SvelteKit's blanket cross-site form check (API clients
  send no Origin header), so that check is replaced by an equivalent guard
  in hooks scoped to cookie-carrying requests — the only surface CSRF can
  actually ride; bearer clients cannot be forged cross-site.
- **Testing**: server code takes a minimal `ArtifactStore` interface
  (`put/get/delete/deletePrefix`); the Worker passes an R2-backed one, the
  unit-test harness an in-memory map. e2e uses wrangler's local R2 (already
  persisted under `.wrangler-e2e`).

### Serving content safely

User-uploaded bytes served from our origin are an XSS surface. Downloads
(`…/content`):

- Always `X-Content-Type-Options: nosniff`.
- Default `Content-Disposition: attachment; filename="…"` (sanitized).
- `?inline=1` is honored **only** for an allowlist — `image/*`,
  `application/pdf`, `text/plain`, `text/markdown` — and always adds
  `Content-Security-Policy: sandbox` so an SVG or HTML-ish payload can't
  script against the app origin. Everything else stays an attachment
  regardless of the flag. Markdown previews in the UI render through the
  existing micromark component (which escapes raw HTML), never via inline
  serving.
- `application/json` is deliberately **not** on the allowlist: a `.json`
  artifact uploads and downloads byte-identically but is always served as an
  attachment. Mirroring that, the upload endpoint's "this endpoint does not
  take JSON" 422 fires only when `?filename=` is absent — the filename is
  what distinguishes an upload from a client that meant the JSON upsert, so
  a named `.json` file is a file like any other, and the CLI's sniff table
  keeps mapping `.json` to `application/json`.
- Folder versions are addressed per file: `…/content?path=<workspace path>`,
  each file under the same header rules (disposition filename = the path's
  basename). A folder `…/content` request without `path` is a 422
  (`folder_path_required`) whose details list the version's paths, so an
  agent self-corrects in one round trip.

## API

Under `/api/v1/*`, existing conventions (auth, structured 422s, cross-user
404s). Artifact routes are name-addressed under the issue for agent
ergonomics; run keys are allowed everywhere here.

| Method & path | Purpose |
| --- | --- |
| `GET /api/v1/issues/:id/artifacts` | List: each artifact with type, description, current version summary, version count, `fresh` flag. |
| `GET /api/v1/issues/:id/artifacts/:name` | Detail: the artifact plus its full version list (metadata only, no contents). |
| `PUT /api/v1/issues/:id/artifacts/:name` | **JSON upsert** for `text` / `link` / `pr`: creates the artifact (body declares `type`) or appends a version to it. Payload fields per type; `description` settable alongside. Type mismatch with an existing artifact → 422 `artifact_type_mismatch`. A body with no payload fields is a metadata-only update (no version). |
| `PUT /api/v1/issues/:id/artifacts/:name/file?filename=…` | **Raw-body upload** for `file`: bytes in the body, MIME in `Content-Type`, creates or appends. Same upsert/type-mismatch semantics. `filename` is required, and its absence is also what identifies a client that meant the JSON upsert: no filename plus an `application/json` body is a 422 naming that mistake, while a named upload takes any MIME type including `application/json`. |
| `PUT /api/v1/issues/:id/artifacts/:name/folder` | **Multipart snapshot upload** for `folder`: one part per file (path as the part filename, MIME as the part type), creates the artifact or appends the next whole-set version. Same upsert/type-mismatch semantics. |
| `POST /api/v1/issues/:id/artifacts/:name/reaffirm` | Append a reaffirming version: copies the current version's payload (same R2 object for files) with a fresh timestamp and the calling actor. 404 if the artifact doesn't exist. |
| `GET /api/v1/issues/:id/artifacts/:name/content` | Bytes of the current version (`?version=N` for history; `?inline=1` per the serving rules; `?path=…` selects a folder entry — required for folders). `file`/`folder` stream from R2, `text` from D1; `link`/`pr` → 422 `no_content` (the reference *is* the payload). |
| `DELETE /api/v1/issues/:id/artifacts/:name` | Delete the artifact, all versions, and its R2 objects. |

The upsert PUT is deliberately the whole write surface: "attach a new design
doc" is the same call whether the slot exists or not, which is exactly the
shape the re-design loop and agents want. Reads and deletes also work through
the generic `/api/v1/context` endpoints by item id (payload summarized);
creation there is rejected as described above.

`GET /api/v1/issues/:id` changes: `context_summary.artifacts` count;
`allowed_transitions[*].requires` with live per-requirement status.

Workflow API changes: `WorkflowTransitionInput` and `WorkflowTransition` gain
`requires?: ArtifactRequirement[]`; `resolveDef` validates them; the
serialized workflow returns them. Nothing else moves.

New shared constants: `ARTIFACT_TYPES`, `ARTIFACT_FILE_MAX_BYTES = 25 MB`,
`ARTIFACT_TEXT_MAX_BYTES = 256 KB`, `ARTIFACT_MAX_VERSIONS = 50`,
`ARTIFACT_FOLDER_MAX_FILES = 200`, `ARTIFACT_FOLDER_MAX_BYTES = 50 MB`
(total per folder version).

Artifact reads carry per-type payload summaries: folder versions report
`file_count`, and detail reads include the file list (`path`,
`content_type`, `size_bytes` — metadata only, never contents).

## CLI

```
tines issues artifacts list <ref>
tines issues artifacts show <ref> <name>                       # detail + versions
tines issues artifacts attach <ref> <name> <source>            # gate-typed (Tines/243): a text
                                                               #   gate reads the path as the
                                                               #   document, a file gate uploads
                                                               #   its bytes, a folder gate walks
                                                               #   it, a link/pr gate takes a URL
                                                               #   or owner/repo#N; ungated, the
                                                               #   shape alone types it — dir →
                                                               #   folder, URL → link (a GitHub PR
                                                               #   URL → pr), owner/repo#N → pr,
                                                               #   anything else → file, a .md
                                                               #   path included. Never text.
tines issues artifacts attach <ref> <name> --file <path>       # file (MIME sniffed from
                                                               #   extension, --content-type to override)
tines issues artifacts attach <ref> <name> --text <md|@file>
tines issues artifacts attach <ref> <name> --link <u> [--title <t>]
tines issues artifacts attach <ref> <name> --pr <owner/repo#N | PR URL>
tines issues artifacts attach <ref> <name> --folder <dir>      # snapshot a directory tree
                                                               #   as one version (MIME per file
                                                               #   sniffed from extensions)
tines issues artifacts attach <ref> <name> … --ignore-gates    # attach this type even when a
                                                               #   requirement rejects it
tines issues artifacts reaffirm <ref> <name>                   # bless current content as fresh
tines issues artifacts get <ref> <name> [--version N] [--out <path>]   # content; link/pr prints the
                                                               #   URL; a folder writes its tree
tines issues artifacts delete <ref> <name>
```

`attach` infers the type from the flag used, or — with a positional `<source>`
— from the gate on the slot; re-attaching appends a version (for a folder, the
next whole snapshot — the agent collects locally and attaches once, e.g.
screenshots taken over a run land as one set). `tines issues move` already
relays structured errors, so a blocked transition prints the unmet requirements
and the attach command verbatim from the error details — the agent loop closes
without any new CLI logic. `tines workflows` create/edit accept `requires`
inside their transition definitions.

**The CLI uses the gate it can already see** (Tines/243). `resolveIssue`
fetches the `IssueDetail`, so `allowed_transitions[].requires[]` is in hand
before the first write and every use below costs no extra request:

- **Typing.** Under a gate the declared type wins over the source's shape, and
  the gate's *concrete* content type is declared with the upload — so
  `attach <ref> prd prd.md` against a `(text, text/markdown)` requirement
  stores bytes identical to `--text @prd.md`. A prefix content type
  (`image/`) is left to the server to sniff. When several available
  transitions gate the slot at different types, the shape discriminates; when
  it cannot, the CLI refuses and names both flags.
- **Refusal before the write.** A flag whose type *no* available transition's
  requirement for that slot could ever accept exits 1 having written nothing,
  quoting the requirement's own `fix` — one gate accepting is enough, and
  `--ignore-gates` skips the check. A content-type-only miss names
  `--content-type` instead. A slot that already holds the wrong (immutable)
  type is refused the same way, with the delete-and-reattach command: the CLI
  teaches the dance rather than converting.
- **Reading the gate.** The line confirming an attach names the transitions the
  new version satisfies (or what a gate wanted instead); `issues show` prints
  each gated transition's requirement with its status and `fix`; and
  `artifacts list` grows a `GATE` column marking rows a gate on the issue
  rejects.

Inline text is never inferred — a positional source is always a path, a URL or
`owner/repo#N`, and the document goes in `--text`.

## Web UI

### Issue page — Artifacts panel

A new section between *Context* and *Comments*: one row per artifact — type
icon (deep-imported Tabler), name, description, current version (`v3 ·
who · when`), and a **stale** badge when the current version predates
`state_entered_at` *and* some transition out of the current state requires the
slot (an unrequired old attachment isn't nagged about). Actions: attach new
version, **reaffirm** (shown prominently on stale rows — the one-click "this
still stands"), delete, and open-in-viewer. Create via an **Attach
artifact** button — drag-and-drop / file picker for files, a directory
picker / folder drop for folders, small forms for text (Markdown editor,
same component as descriptions), link, and PR.

Rows stay **one line tall**. The only inline content is a lazy image
thumbnail (image files, and up to a few image entries of a folder — the
glanceable case); everything else shows metadata only. `link`/`pr` rows
render as outbound anchors (PR shown as `owner/repo#N`).

**Viewer dialog.** Content viewing and history live in one dialog, not
inline — a design doc or screenshot set expanding inside the issue column
pushed the page around and starved wide content (the reason the original
inline previews were replaced). Clicking a row (or a thumbnail) opens the
viewer: an **artifact switcher** (dropdown over the issue's artifacts, so a
reviewer flips doc → screenshots → PR without reopening), a **version
picker** (defaulting to current; reaffirmations labeled "reaffirmed vN"),
a download affordance, and a metadata line (type, content type, size,
actor, fresh/stale). The body renders by type: Markdown through
`Markdown.svelte`, images full-size, plain text in a scrollable `<pre>`,
PDFs in an `<iframe>` against the sandboxed inline URL (the dialog is what
makes PDF preview possible at all), other files as a download link,
`link`/`pr` as outbound cards. A folder renders as an image-grid gallery
when every file is an image, else as a file tree with per-file preview.

### Transitions

Transition buttons in the *State & transitions* section show their
requirements: satisfied ones as subtle checks, unmet ones as the reason the
button is disabled (with `missing` / `stale since <time>` and the requirement
description). The forced-state escape hatch is unchanged and visually
separate, as today.

### Workflow editor

Each transition row gains a requirements editor: add/remove rows of
(artifact slug, optional type select, optional content-type, optional
description). Validation errors from `resolveDef` render inline.

## Alternatives considered

- **A dedicated `artifact` table instead of a context kind.** Rejected:
  the context item already provides user scoping, issue attachment, name
  uniqueness per scope, events with actor attribution, and a listing surface;
  a parallel table would re-implement all of it. The parts of the context
  system artifacts *don't* want (effective-context merging, prompt stitching,
  `--out`) are exactly the parts a kind can opt out of. The version child
  table is the sanctioned collection shape.
- **Base64 in D1 / text-only v1** instead of R2. Rejected: screenshots are a
  headline use case, and D1 blobs bloat the database for strictly worse
  serving. R2 is greenfield but small: one binding, one proxy endpoint pair,
  one storage interface.
- **Requirements on the target state** ("entering Implementation requires…").
  Rejected: edge-specific gating is the point — "send back to design" and
  "approve into implementation" must gate differently even when a state has
  several inbound paths. States can't express that; transitions can.
- **Requirements in a child table keyed on `workflow_transition.id`.**
  Rejected: `updateWorkflow` re-creates transition rows with fresh ids on
  every PATCH, so the rows would be re-keyed constantly for no benefit; a JSON
  column re-created with its row is simpler and matches how requirements are
  edited (wholesale, inside the workflow definition).
- **Explicit stale-marking on transition** (stamp artifacts stale when a state
  is re-entered). Rejected: it mutates rows on a read-shaped rule, needs
  un-marking flows, and drifts when workflows change. One timestamp
  comparison against `state_entered_at` derives the same answer statelessly.
- **Presigned R2 URLs** for upload/download. Rejected for v1: requires
  account-level S3 credentials outside the Worker binding model; proxying
  through the Worker keeps auth, caps, and headers in one place. Revisit if
  file sizes outgrow Worker limits.
- **Inlining small text artifacts into the launch prompt.** Rejected: the
  user-stated contract is that artifacts are *not* auto-included; a listing
  plus fetch commands keeps prompts bounded and the contract clean.
- **Freshness keyed to re-entry only** (first entry into a state grandfathers
  older attachments). Rejected: distinguishing first entry from re-entry
  re-introduces event mining, and "fresh since the issue last entered its
  current state" is one rule a human can hold in their head. The
  attached-during-backlog edge is accepted and surfaced honestly in the UI.

## Acceptance criteria

Done when this loop works end-to-end:

1. Edit a workflow so *design → implementation* (action "approve") requires
   artifact `design-doc` with `content_type: text/markdown`; the workflow
   PATCH round-trips `requires` and the editor shows it.
2. An issue in *design* with no artifacts: the issue page disables "approve"
   citing the missing `design-doc`; `tines issues move` returns the 422 with
   `status: "missing"` and the attach command; the launch prompt's transition
   list shows the requirement.
3. `tines issues artifacts attach tines/42 design-doc --file design.md` (as a
   run-key actor) creates the artifact; "approve" now succeeds. The event feed
   shows the context event attributed to the agent.
4. Send the issue back to *design*: the artifact shows **stale**, "approve" is
   blocked with `status: "stale"` and the prior version's timestamp; attaching
   a new version (v2) unblocks it; both versions remain listed and
   downloadable, and the v1/v2 contents differ as uploaded.
   Send it back once more: `tines issues artifacts reaffirm tines/42
   design-doc` (or the UI button) appends v3 labeled "reaffirmed v2" with the
   affirming actor, serves v2's exact bytes without a new R2 object, and
   unblocks "approve" again.
5. Upload a PNG as `feature-screenshot`: it renders inline on the issue page;
   its download URL is attachment-by-default, inline-with-sandbox when
   requested; a 30 MB upload is a 422 naming the cap.
6. Attach `impl-pr` via `--pr acme/app#123`: it lists as `acme/app#123`
   linking to the PR; `…/content` returns `no_content`; a transition requiring
   `impl-pr` of type `pr` passes.
6b. `tines issues artifacts attach tines/42 screenshots --folder ./shots`
   uploads a mixed tree (subfolders included) as one v1 snapshot; a generic
   transition requiring `screenshots` of type `folder` passes on every issue
   regardless of which files the set contains; each file serves at
   `…/content?path=…` under the safety headers; `…/content` without `path`
   is a 422 listing the paths; re-attaching the directory is v2 (whole set);
   reaffirm appends v3 reusing v2's objects; `get --out` writes the tree;
   a folder requirement declaring `content_type` is rejected at definition
   time; per-version caps (200 files / 50 MB) reject with 422s naming them.
7. A human force-sets the state past an unmet gate (recorded `forced: true`);
   the same PATCH with a run key is a 403 on the `state` field.
8. `POST /api/v1/context` with `kind: "artifact"` is a 422; the Context tab
   and `GET /api/v1/context?issue=…` list the artifacts with type icons;
   deleting one removes its versions and R2 objects.
9. Artifacts appear in the launch prompt's Artifacts section with fetch
   commands and never inline their contents; the effective-context response
   and `tines issues context --out` are byte-identical to before this feature
   when no artifacts exist, and ignore artifacts when they do.
10. `pnpm check`, `pnpm test` (in-memory store), and the e2e suite (local R2)
    pass.

## Resolved questions

From the design discussion:

- **Storage**: R2, not D1 — screenshots are core, and this is the reserved
  "R2 becomes a kind when binaries are needed" moment from the context spec.
- **Staleness**: derived by timestamp (`version.created_at ≥
  issue.state_entered_at`), no mutation on transition, no explicit stale flag.
- **Requirement matching**: named slot + optional type/content-type — not
  type-only, not free-form human checkboxes.
- **Anchor**: requirements live on transitions (declared inline in the
  workflow definition), not on target states.
- **Agent access**: run keys get full artifact read/write — agents satisfy
  their own gates; review gates belong to `awaiting_human` states. Workflow
  (and thus requirement) definitions remain control-plane-fenced.
- **Force path**: forced state-set bypasses gates but becomes human-only; run
  keys lose the `state`/`workflow_id` fields on issue PATCH.
- **Type set**: `file`, `text`, `link`, `pr` shipped first; `folder` was
  added once the screenshot use case made the need concrete (below).
- **Versioning**: immutable per-artifact history, current-by-default UI, kept
  specifically so a redesign's doc can be compared against its predecessor.
- **Prompt posture**: artifacts are listed (name/type/description + fetch
  command) in the issue block, contents fetched on demand, never inlined.

From the spec review:

- **Caps**: 25 MB per file, 256 KB per text artifact, 50 versions per
  artifact — generous but bounded, in the existing cap philosophy.
- **Stale badge**: requirement-relevant only — "stale" means "this will block
  a move"; incidental attachments (a reference screenshot nobody gates on)
  are not nagged about.
- **`pr` shape**: canonical GitHub only (`https://github.com/{owner}/{repo}`
  + number), matching every other GitHub touchpoint in the system. A second
  provider later loosens validation additively; the `link` type is the
  escape hatch for non-GitHub review URLs today.
- **Reaffirm**: marking a stale artifact fresh without re-uploading is a
  first-class action, modeled as a new version reusing the prior payload —
  chosen over a separate `affirmed_at` timestamp (second freshness input,
  weaker audit trail) and over having no reaffirm at all (pointless
  re-uploads). Open to run keys, since re-uploading identical bytes was
  always possible.
- **Strict freshness stands**: no first-entry grandfathering — one rule
  ("fresh since the issue last entered its current state"), with reaffirm as
  the cheap remedy for attached-early artifacts.
- **Requirements storage**: confirmed as a JSON column on
  `workflow_transition`, not a child table — no per-row identity, edited
  wholesale with the definition, and nothing needs a which-transitions-
  require-X SQL query.
- **Write surface**: confirmed as the upsert `PUT` (single call whether the
  slot exists or not); the POST-create/PATCH-update convention deviation is
  deliberate and confined to artifacts. No CAS/If-Match guard — versions are
  append-only, so a concurrent attach loses nothing.

From the folders/viewer review:

- **Previews moved to a viewer dialog** (with an artifact switcher and
  version picker); inline expansion had unbounded Markdown height inside the
  issue column and could never host PDFs. The one inline survivor is the
  image thumbnail — the genuinely glanceable case.
- **Screenshots are a folder, not sibling files** — because workflows are
  generic over issues: a requirement names one fixed slot (`screenshots`),
  while each issue's surfaces differ, so per-screen slot names are invisible
  to the gate. Pattern/prefix requirement matching was rejected (it reopens
  all-fresh vs any-fresh ambiguity and breaks the one-name-one-slot error
  story). Sibling `file` artifacts remain right where a single file has
  standalone identity and per-round history matters.
- **Snapshot-only versions** — the agent collects locally and uploads the
  folder in one go. Per-file incremental writes (derive version N+1 from N ±
  one file) were designed and rejected: they add a write surface, and an
  increment implicitly blessing the rest of a stale set weakens freshness.
  A run that dies mid-collection lands nothing, which is correct — the
  artifact is round-level evidence, and the supervisor retries the run.
- **Upload shape**: one `multipart/form-data` request, path-as-filename per
  part — over zip (no archive handling in the Worker, per-file objects and
  serving fall out) and over staged writes (no mutable draft state).
- **Folder caps**: 200 files / 50 MB per version — the multipart parse is
  buffered in Worker memory; streaming or presigned uploads are the trigger
  for raising them.
- **No `content_type` on folder requirements** (422 at definition time):
  mixed-type trees admit no honest all-files/any-file match rule; the gate
  asserts slot + type, prose says what belongs inside.

From later work:

- **2026-09-01, Tines/92 — the link payload flag is `--link`, not `--url`**: `-u, --url` is the API base URL on every CLI command without exception. `attach … --url <link>` used to suppress the base-URL flag and attach the link, so an invocation that copied the documented `--url` idiom silently produced a `link` artifact pointing at the API base URL. Renaming makes that misuse an offline arity error carrying the corrective hint; the server-generated `fix:` line and launch-prompt "Attach one:" hint teach `--link`.
- **2026-09-06, Tines/241 — the requirement is the single source for every attach hint**: the `attachFlag`/`fixFor` logic moved out of the 422 builder into `requirementFix` in `@tines/shared`, and `fix` became a required field on `ArtifactRequirementCheck`. The three surfaces that tell someone how to attach — launch prompt, issue read, 422 — can no longer drift from each other or from the gate, and the CLI can import the same function. Rendering stays on today's *flag* forms (`--text @<slot>.md`, not a positional path): runner CLIs lag npm by days, so a hint the installed CLI cannot parse is worse than a generic one.
