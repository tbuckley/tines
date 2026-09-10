# Adding a context kind

Context items are typed — `prompt`, `skill`, `repo`, `artifact` — and the
type set is designed to grow ([specs/context/SPEC.md](../specs/context/SPEC.md)).
`kind` is an open string with a per-kind payload, so a new kind is an
**additive** change: no row migration, and no changes to scoping, layer
ordering, name uniqueness, events, list filters, lifecycle guards, or the
launch-prompt machinery. This doc is the process, using a hypothetical
`mcp` kind (an MCP server config to hand an agent's workspace) as the
running example.

One rule up front: **strictness ships with the kind.** The API's
open-endedness is a schema-design property, not laxity — an unknown kind
is a 422, and payload fields that don't belong to the declared kind are
rejected, not dropped. A new kind must land with its field allowlist,
validator, and caps in the same change; there must never be a moment where
a kind accepts arbitrary payload.

## 1. Design decisions (before any code)

1. **Payload storage.** Two sanctioned shapes:
   - **Nullable columns** for flat payloads — how `repo` stores
     `repo_url` / `repo_branch` / `repo_dir`.
   - **A JSON `config` column** for structured payloads. The parent spec
     reserved this deliberately ("a future kind with a structured payload
     can use a JSON `config` column added at that time"), and `0011` has
     since added it; the `artifact` kind stores `{"artifact_type": …}`
     there. A new structured kind reuses that column rather than adding
     one. `mcp` (command, args, env) would take this route.
   - Child tables are for repeated sub-entities only (`context_item_file`
     for skill files); don't reach for one unless the payload is a
     collection with per-row identity.
2. **Merge semantics.** Prompts are the only concatenating kind. Every
   other kind takes the uniform rule: **dedupe by name; the later (more
   specific) layer wins wholesale** — that's the override mechanism, and
   `overridden` reporting comes for free. Take the default unless the
   kind's nature genuinely demands otherwise; deviating is a spec-level
   decision, not an implementation choice.
3. **Consumption shape.** What the effective-context response calls it (a
   new top-level array beside `skills` / `repos`) and what
   `tines issues context --out` writes for it (a file beside `repos.json`,
   e.g. `mcp.json`). Decide whether it can conflict with itself the way
   repo checkout dirs do; if so, report it in `conflicts` and let `--out`
   refuse, same posture as `repo_dir`.
4. **Caps.** Every payload is byte-capped (UTF-8), enforced at the API
   layer with structured 422s. Pick the cap when you pick the shape.

Write these down as a short section in `specs/context/SPEC.md` (payload
shape, caps, merge rule, bundle form) as part of the change.

## 2. Mechanical checklist

In dependency order. Roughly 150–250 lines total; most of it is the two
UI panels.

### Migration — `apps/web/migrations/000N_….sql`

- Add the payload column(s), if the kind needs any of its own. A
  structured payload needs none: `config TEXT` already exists (`0011`).
- There is no `kind` CHECK constraint to widen — `0006` rebuilt the table
  without it, leaving the API layer as the real gate (the same trade the
  spec already makes for name uniqueness). A kind that adds no column
  therefore needs no migration file at all.

### Shared types — `packages/shared/src/types.ts`

- Add the kind to the `ContextKind` union **and** `CONTEXT_KINDS` — the
  unknown-kind 422 allowlist reads `CONTEXT_KINDS`, so validation and the
  error message update themselves.
- Payload fields (optional) on `ContextItem`, `CreateContextItemRequest`,
  `UpdateContextItemRequest`.
- The effective entry type (e.g. `EffectiveMcp`) and its array on
  `EffectiveContext`; a per-kind count field on `ContextSummary`.
- Caps as exported constants next to `PROMPT_MAX_BYTES`.

### DB types — `apps/web/src/lib/server/db.ts`

- New column(s) on `ContextItemTable`.

### Server — `apps/web/src/lib/server/api/context.ts`

This file is where kind identity lives; everything else treats `kind` as
an opaque string.

- **`KIND_FIELDS`**: one entry mapping the kind to its allowed payload
  fields. This single map drives foreign-field rejection
  (`kind_payload_mismatch`) for every kind, including rejecting *your*
  fields on other kinds.
- A payload **validator** (shape + caps → structured 422s), called from
  `createContextItem` and `updateContextItem` alongside
  `validatePromptBody` / `validateFiles`.
- **`serializeItem`**: emit the payload for the new kind.
- **`effectiveContextForIssue`**: filter matched rows by the kind, run the
  generic `dedupeByName`, and map winners into the response array (plus
  conflict detection if decision 3 called for it).
- **`contextSummaryForIssue`**: add the post-dedupe count (distinct names
  among matching rows of the kind).

Nothing else in the server changes: `requireKind`, scope resolution,
name-uniqueness, positions, events, and the deletion guards are all
payload-agnostic.

### CLI — `packages/cli/src/`

- `commands/context.ts`: payload flags on `context create` / `context edit`
  (never take `--url` for a payload — that is the API base URL on every
  command; name the flag for what it holds, as the repo kind does with
  `--repo-url`), plus a line in `printContextItem` (show rendering).
- `format.ts`: a line in `contextItemSummary` (list rendering).
- `commands/issues.ts`: the `--out` bundle file in `issues context`.

### Web UI — `apps/web/src/lib/components/`

- `ContextItemEditor.svelte`: a kind-picker radio label and a payload
  panel.
- `ContextKindIcon.svelte`: an icon (deep-imported, per CLAUDE.md).
- `ContextItemList.svelte`: the row's payload summary.
- `EffectiveContextView.svelte`: a section in the effective preview.

### Agent-editing surface (once AGENT_EDITING.md is implemented)

- Artifact kinds join the "Attached to this issue: …" footnote line in
  the launch prompt's Journal section. The journal, proposal, and append
  machinery are kind-agnostic — no other changes.

### Tests and docs

- Unit tests for the validator in
  `apps/web/src/lib/server/api/context.test.ts`.
- e2e coverage in `apps/web/e2e/context.spec.ts`: create with valid and
  invalid payloads, foreign-field rejection both directions, presence in
  the effective response, override-by-name.
- The spec section from step 1.

## 3. What you should NOT need to touch

If a new kind requires edits to any of these, the change is off the rails
— stop and reconsider the design:

- Scope columns, coherence validation, or the layer-rank ordering.
- Name-uniqueness or position handling (per exact scope, kind-aware
  already).
- Event emission (`context.*` payloads carry `kind` as-is).
- Lifecycle guards (`findAttachedContext` / `sweepAttachedContext` sweep
  by scope, not payload).
- List filtering, pagination, or the launch-prompt/journal machinery.
- Existing rows or existing clients: old rows never match the new kind,
  and clients that don't know it simply see items whose payload fields
  they ignore — the wire types are additive.

## 4. Definition of done

- [ ] Spec section written (shape, caps, merge rule, bundle form).
- [ ] Any migration applies on a fresh DB and on one carrying existing items.
- [ ] Unknown-field and wrong-kind payloads 422 in both directions.
- [ ] Item round-trips through API, CLI, and the web editor.
- [ ] Appears in the effective context with dedupe-by-name override
      behavior and in `context_summary`.
- [ ] `tines issues context --out` writes the agreed bundle form.
- [ ] Library export/import handles the kind: a serializer in
      `buildLibraryDocument` and the matching payload mapping in
      `writeContextEntry` (`apps/web/src/lib/server/api/library.ts`).
      Without both, items of the new kind silently fail to travel between
      deployments.
- [ ] `pnpm check`, `pnpm test`, and the e2e suite pass.
