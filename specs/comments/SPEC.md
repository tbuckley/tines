# Tines — Comment Editing Spec

Extends [phase one](../phase_01/SPEC.md), which scoped comments to "create and
list; no editing or deleting". That restriction is lifted here (Tines/11).

The motivating failure is on the record: in Tines/3's review thread an agent
posted the literal string `--help` as a comment, and it had to stay there
forever because nothing in the CLI or API could remove it. Comments are the
durable narrative every run is told to start from, so a thread that cannot be
corrected degrades permanently — one shell-quoting slip at a time.

## Goals

- An author can repair its own mis-post: replace the body, or remove the
  comment entirely.
- A human can clean up after an agent, which is the case that actually recurs.
- Agents cannot rewrite each other's handoff notes.
- The activity log still records that an edit or a deletion happened.

## Decisions

### Authorization is asymmetric, not "author only"

Sessions and named API keys may edit or delete **any** comment in their own
workspace. A **run key** may only touch comments whose `actor_api_key_id` is
its own; anything else is `403 run_key_forbidden`.

Strict author-matching was rejected: run keys are minted per run and revoked
when it ends, so an agent's comment would be immortal the moment its run
finished — the Tines/3 cleanup would still be impossible. Unrestricted access
was also rejected: it would let one agent silently rewrite another's handoff
note, against the affordance asymmetry of
[AGENT_EDITING.md](../context/AGENT_EDITING.md).

Tines is single-tenant per user, so a *different* user never reaches the
comment at all — the issue lookup is owner-scoped and 404s first. The 403 above
is the only authorization boundary that can exist inside one workspace.

The rule is a field-level guard in the service, not a `CONTROL_PLANE_PATTERNS`
entry: the route must stay reachable for the run key that authored the comment.

### Events carry the action, not the content

`issue.comment_edited` carries `{ comment_id, changed: ['body'] }`;
`issue.comment_deleted` carries `{ comment_id, body_length }`. No prior body.

No event in this system stores prior content (`issue.updated` records only
which fields changed), bodies cap at 100k characters, and an issue page loads
100 events. Decisive, though, is that the best reason to delete a comment is a
mis-pasted secret: copying it into an append-only stream that has no delete
would defeat the feature.

Event names take the `issue.` prefix of the owning entity, like
`issue.commented` and `issue.link_added` — both feed surfaces key off it.

### Hard delete

Nothing references `comment.id`, and with content-free payloads a tombstone
would preserve nothing worth keeping. The event is the record that a comment
was deleted; the text is gone.

### Discoverability

Comment ids appear in `tines issues show` (both `--json` and the human view)
and are echoed by `tines issues comment`, so an agent that mis-posts holds the
handle it needs. The launch prompt names the repair commands but does not list
ids for every comment: the comment you just wrote is the one you legitimately
need to fix.

> 2026-09-23 project-sharing decision: [SHARING_2026-09-23.md](../projects/SHARING_2026-09-23.md) supersedes this spec’s single-owner assumptions for shared projects. This historical spec remains unchanged otherwise.
# 2026-09-21 — API-key scope enforcement (Tines/648)

Comment reads and writes require authority on the issue's project. Hard deletion requires project delete in addition to the existing author/run ownership rule. Run keys remain confined to their bound issue. See `../api-keys/SPEC.md`.
