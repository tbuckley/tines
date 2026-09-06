# Handoffs

How a round of agent work is handed back to a human, and how the human's steer
is handed forward to the next run. Everything here is *derived* at read time
from run attribution the supervisor already writes — no column stores a round.

## Goals

- A human opening an issue that came back sees what the round produced, per
  stage, without reading the whole thread.
- An agent launching on an issue a human just touched reads the human's steer
  first, before anything else in the issue block.
- Neither side changes how a run behaves: a run still attaches its artifact,
  posts its summary comment and takes its transition, exactly as before.

## Decisions

- **The round boundary is the last human-taken transition, else the issue's
  creation.** "Human-taken" means the `issue.transitioned` event's actor has no
  run behind its API key. A forced move (`issues edit -s`) counts — a human made
  it — and renders "moved directly", since the event carries no action. A
  workflow change does *not*: it re-stamps `state_entered_at` but emits
  `issue.updated`, so it never resets the boundary; `arrived_via` nulls out
  after one (guarded on `created_at >= state_entered_at`) rather than naming a
  transition that did not happen.
- **A run's summary comment is its last comment on the issue**; its earlier ones
  fold to `earlier_comment_ids`, resolvable against `IssueDetail.comments`. Only
  one body per run is duplicated onto the payload, not the whole thread.
- **A stage visited twice in one round is one group, latest run first.** Every
  earlier attempt carries `returned_via`: the transition that brought the issue
  back into that state afterwards ("sent back by Automated Review").
- **Attribution is by run id, never by the run's issue ref.** A comment or
  artifact version left on this issue by a run working *another* issue appears
  in the thread but in no round entry.
- **`since_last_run` measures from the previous run**, the newest run that is no
  longer active — at dispatch the current run's row already exists. It is
  present when a human transitioned the issue or commented after that run ended,
  and absent when the previous run's transition led straight to another run. A
  comment-only steer is present with `transition: null`.
- **Human comments are capped at ten** (the newest ten, oldest first) with
  `comment_count` reporting the total. The prompt's `### Since the last run`
  duplicates comments that also appear under `### Comments`: accepted, because
  the steer is the reason the run exists.
- **`stale_artifacts`** names artifacts whose current version was attached in
  the state the human sent the issue back *from* — fresh when they looked at it,
  stale now.
- **Row derivation is awaiting-human only.** `arrived_via` and
  `round_boundary_at` are `CASE`-gated subqueries, so active rows and the
  dispatch path's `loadIssue` run neither; `round_summary` is one keyed query
  per page that has an awaiting row, and no statement at all otherwise.
- **The detail derivation is opt-in** (`IssueDetailOptions.round`).
  `getIssueDetail` sits on every mutation's return path; only the two issue
  read endpoints, the prompt route and the runner's prompt delivery ask for it.

## Non-goals

- No agent behaviour, stage prompt, CLI flag or agent-facing command changes.
- No linkage between a transition and a comment, and no atomic comment+move.
- No aggregation of waiting time or cost across issues, and no PR check status.
- No UI: the handoff card, the Awaiting rows and the brief are Tines/264, which
  consumes these fields.
