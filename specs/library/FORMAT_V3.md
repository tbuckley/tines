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

Schedules reference a bundled or input workflow and an input project. They preserve portable recurrence, timezone, templates, `require_all_closed`, and either follow-initial (`start_state: null`) or an explicit bundled state. Installation creates selected schedules paused, with no run count, issue, or dispatch.

Routing entries target a bundled state with an optional input project and contain a portable tier, never a publisher runner ID. Preparation checks the destination's actual eligible capabilities and ordinary routing specificity.

## Confirmation and installation

Preparation is read-only and returns the complete rendered content, operations, destination choices, signed 15-minute plan, document digest, and plan digest. The plan binds actor, owner, destination witnesses, names, values, schedules, routing, allocated IDs, and compiler version. Editing any bound choice requires a new plan and confirmation.

Installation requires a session or named API key; an agent run key may export, validate, and prepare but cannot install. One guarded D1 batch first inserts a request-specific receipt, then gates every object, file/version, inheritance, and event statement on that receipt and an attempt-specific execution nonce. Failure or stale witnesses write nothing. A matching durable receipt makes concurrent retries and lost-response retries return one result without duplication, including after plan expiry. Success creates ordinary editable objects, selected paused schedules, and tier-only rules; it creates no issue and changes no project default.

## Compatibility

Versions 1 and 2 remain readable by the legacy best-effort importer. Version 1 has no inheritance semantics: an absent or permissively present inheritance field can neither compare, set, nor clear a destination pointer in either collision mode. Version 2 retains its existing merge semantics. Ambiguous legacy workflow names or slash-delimited state references are refused rather than guessed. Whole-library v3 uses local IDs so duplicate names and their prompts remain distinct, but it retains best-effort rather than atomic guarantees.
