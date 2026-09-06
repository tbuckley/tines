# Tines — Project Archival Spec

Extends [phase one](../phase_01/SPEC.md), whose non-goals deferred deletion and
archival wholesale. Project archival is lifted out of that deferral here
(Tines/195 → Tines/206 for the server and CLI, Tines/207 for the browser and
these docs). Issue deletion stays deferred.

The motivating failure: a finished project keeps costing attention forever. Its
issues still appear in every list, its schedules still create work, agents still
dispatch on it, and the only way to stop that was to delete the project — which
the API refuses while it holds issues, and which would take the record with it.

## Goals

- Retire a project without losing anything: every link, ref, artifact, comment
  and URL keeps resolving after archiving.
- Stop the project generating work: no dispatch, no schedule firing, no writes.
- Reversible with one command or one button, at any time.
- Never strand a run that was already under way.

## Decisions

### Archive drains, it does not refuse

Archiving a project with active runs succeeds. The runs finish on their own
issue and are reported in the response's `draining_runs`. Refusing would make
archiving unreliable exactly when a project is busiest; killing the runs would
throw away work and leave half-written issues. `/api/v1/runs/*` and
`/api/v1/runners/*` stay ungated so a draining run can report and be cancelled.

### Hidden by default, nameable on request

Lists hide archived projects rather than filtering them out of existence, and
**naming an anchor overrides the default**. Anything else silently empties a
list that a stale URL or a saved filter points at.

### Schedules keep `enabled`

The sweep skips an archived project's schedules without clearing their
`enabled` flag, so unarchiving restores exactly the state the user left. The UI
labels such a row "paused · project archived" rather than lying in either
direction.

### The name stays reserved

An archived project still owns its name: creating a new project with it is
`duplicate_project_name`. Reusing the name would make refs (`Project/12`)
ambiguous across the archive boundary.

## Rules

1. **Hidden.** `GET /projects`, `/issues`, `/schedules` and `/context` omit
   archived projects by default. `GET /projects` takes
   `?archived=true|false|all` (it has no anchor). Naming an anchor overrides the
   default: `project`/`projectId` for issues and schedules; `project` **or**
   `issue` for context — an issue names its place as firmly as a project, so an
   archived project's issue page shows its context unchanged. The CLI exposes
   `projects list --archived` only; `issues|schedules|context list` have no such
   flag, and `?archived=all` is reachable at HTTP only.
2. **Read-only.** Every write anchored on an archived project or one of its
   issues is `422 project_archived`, whose message quotes
   `tines projects unarchive "<name>"` (also in `details.unarchive_command`).
   **Drain exemption**: a run key whose run is still active on an issue of the
   project may update, transition, comment, label and attach artifacts on *that
   issue*, and may write context scoped to that issue. Project- and
   state-scoped context writes (`tines journal append` included) are still
   refused.
3. **No automation.** The dispatch pass and the schedule sweep skip archived
   projects; `tines issues dispatch` reports the `project_archived` check
   ("project <name> is archived (since YYYY-MM-DD) — nothing dispatches").
4. **Resolvable.** Refs, URLs, artifacts, context bundles, activity and every
   other read keep working; `getProject` is unfiltered.
5. **Name reserved.** `duplicate_project_name` still applies against an
   archived project.
6. **Archive drains.** Archive never refuses for active runs; the response
   carries `schedules_paused`, `issues_read_only` and `draining_runs`
   (`run_id`, `runner_name`, `issue_id`, `issue_number`). Cancelling a run stays
   available while the project is archived.
7. **Unarchive.** Enabled schedules re-arm to their next *future* occurrence —
   no catch-up run — and a dispatch pass is queued. The response carries
   `schedules_resumed`.
8. **Control plane.** `POST /projects/:id/archive` and `…/unarchive` are
   refused to run keys (`run_key_forbidden`). Both are idempotent and return
   200.
9. **Events.** Archiving and unarchiving append `project.archived` /
   `project.unarchived` to the activity log.
10. **Web.** `/projects` shows a "Show archived (n)" toggle whose state lives in
    the URL (`?archived=1`) and is remembered by nav-memory for the Projects
    nav tab; archived cards are muted, badged and sorted after live ones. The
    project page carries an amber "Archived <date> · Unarchive" banner, and
    Settings offers Archive / Unarchive. On an archived project's issue pages
    every mutating control is disabled with the tooltip "Project archived —
    unarchive to make changes" (Cancel run excepted, per rule 6) and every read
    is untouched. Any project select that a URL or a saved rule can point at
    keeps the archived project selectable, rendered "<name> (archived)", so
    nothing is silently unset or silently unfiltered.

Recorded non-issue: `GET /issues?schedule=<id>` with no project returns empty
for an archived project. That parameter is a highlight id, unreachable from the
app and absent from the CLI, so it is documented rather than fixed.

## Non-goals

- Deleting projects or issues (deletion of a project with issues is still
  refused; issue deletion stays deferred per phase one).
- The project-focus switcher's behaviour when its project is archived
  (Tines/196).
- Per-project cost reporting (Tines/187).
- Archiving anything other than a project — issues, workflows and context items
  have no archived state.
