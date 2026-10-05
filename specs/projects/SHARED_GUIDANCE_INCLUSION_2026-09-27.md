# Decision: owners include library guidance in a shared project (2026-09-27)

Recorded for Tines/752. This amends `SHARING_2026-09-23.md`, which is left as written.

## Problem

Once a project is shared, its agents run with guidance from the owner's library.
Project, issue and workflow-stage items obviously belong to the project, but the
owner's global and label-only items may be private (another client, personal
habits). Sharing them silently leaks them to members. Dropping them silently
changes how the owner's own agents behave.

## Decision

- Project-, issue- and workflow-state-anchored items are shared automatically.
- Global and label-only prompts, skills and repos stay private until the owner
  **includes** them (`tines projects guidance include`, or the project page's
  "Include from library"). Inclusion references the live item; future edits stay
  shared. Excluding it removes it from the next read.
- Only the owner may include or exclude. Members get 403 `owner_only`, run keys
  get 403 `run_key_forbidden`, and outsiders get 404. Inclusion events stay out of
  the member feed.
- Env items and artifacts are never shared. Env values reach the owner's own
  runs over the launch env channel only.
- Member execution stays disabled. This decision only defines what a member
  can read and what the owner's runs in a shared project receive.
