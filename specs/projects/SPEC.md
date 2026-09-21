# Tines — Projects Spec

Two subsystems share this file because they share one rule set about which
projects exist and which one you are looking at: **Archival** (Tines/195) and
**Project focus** (Tines/196).

## Archival

Extends [phase one](../phase_01/SPEC.md), whose non-goals deferred deletion and
archival wholesale. Project archival is lifted out of that deferral here
(Tines/195 → Tines/206 for the server and CLI, Tines/207 for the browser and
these docs). Issue deletion stays deferred.

The motivating failure: a finished project keeps costing attention forever. Its
issues still appear in every list, its schedules still create work, agents still
dispatch on it, and the only way to stop that was to delete the project — which
the API refuses while it holds issues, and which would take the record with it.

### Goals

- Retire a project without losing anything: every link, ref, artifact, comment
  and URL keeps resolving after archiving.
- Stop the project generating work: no dispatch, no schedule firing, no writes.
- Reversible with one command or one button, at any time.
- Never strand a run that was already under way.

### Decisions

#### Archive drains, it does not refuse

Archiving a project with active runs succeeds. The runs finish on their own
issue and are reported in the response's `draining_runs`. Refusing would make
archiving unreliable exactly when a project is busiest; killing the runs would
throw away work and leave half-written issues. `/api/v1/runs/*` and
`/api/v1/runners/*` stay ungated so a draining run can report and be cancelled.

#### Hidden by default, nameable on request

Lists hide archived projects rather than filtering them out of existence, and
**naming an anchor overrides the default**. Anything else silently empties a
list that a stale URL or a saved filter points at.

#### Schedules keep `enabled`

The sweep skips an archived project's schedules without clearing their
`enabled` flag, so unarchiving restores exactly the state the user left. The UI
labels such a row "paused · project archived" rather than lying in either
direction.

#### The name stays reserved

An archived project still owns its name: creating a new project with it is
`duplicate_project_name`. Reusing the name would make refs (`Project/12`)
ambiguous across the archive boundary.

### Rules

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
    nothing is silently unset or silently unfiltered — except the `/issues`
    list, whose project scope is the focus (below) and which has no project
    select at all: a stale `?project=` naming an archived project becomes a
    notice there, not a selection.

Recorded non-issue: `GET /issues?schedule=<id>` with no project returns empty
for an archived project. That parameter is a highlight id, unreachable from the
app and absent from the CLI, so it is documented rather than fixed.

### Non-goals

- Deleting projects or issues (deletion of a project with issues is still
  refused; issue deletion stays deferred per phase one).
- Per-project cost reporting (Tines/187).
- Archiving anything other than a project — issues, workflows and context items
  have no archived state.

## Project focus

The project is a sticky, per-user **focus** rather than a URL filter (Tines/196
→ Tines/259 for this half; Tines/260 extends the readers). One focus per user:
either "All projects" or exactly one live project.

### Goals

- The project you are working in survives a reload, a new tab and another
  device, without a parameter in the URL.
- Scope is visible in the chrome, so no list has to explain what it is showing.
- Agents and the CLI are untouched: a focus is a human's view, never a
  permission or routing boundary.

### Decisions

**Server-side, not a cookie.** The focus lives in `user_preference`
(`focused_project_id`, `last_project_id`), read by the `(app)` layout in the
same wave as the project list. A cookie would be per-device and would have to be
re-sent from every client; the row costs one primary-key lookup.

**Opening a project page sets the focus.** It does not merely offer it: opening
`/projects/<id>` is the clearest statement of what you are working on. The write
is made from the client, never from the page `load` — the app preloads links on
hover, so a load-side write would flip the focus on hover of a grid card.

**`?project=` is retired as a persistent filter.** `/issues`, `/context`, and
`/activity` each have one address; `?project=<id|name>` on any is a **one-shot**
that sets the focus and redirects (keeping every other filter). There is no "from
link" mode and no marker: after the redirect the chrome is the only thing
saying what the scope is.

### Rules

1. **What sets the focus:** the chrome switcher, opening `/projects/<id>`,
   creating a project (its `goto` lands on the project page), and the
   list one-shots above. An issue in another project only offers a `Focus
   <project>` action; merely following a cross-project link never changes focus. `last_project_id` is a
   New-issue default, not a focus, and setting a focus also sets it.
2. **What the focus scopes:** Issues and its counts; Context items anchored on
   the project or one of its issues (with a separate shared global/state count);
   project-tagged Activity events; workflow open-issue usage; and the Agents
   routing/runs presentation. Runners, queue, quotas and automation controls
   remain workspace-wide. New-item editors default to the focus. No API list applies it.
3. **A ref that cannot be honoured writes nothing.** An unknown `?project=`
   renders the current list with "No project `<ref>`. Showing <scope>."; a ref
   naming an archived project says so and links to it. Both leave the focus as
   it was.
4. **Resolution.** A focus whose project is missing or archived reads as All
   projects, and the layout clears the stored pointer lazily — so unarchiving
   the project does **not** restore it as the focus. Deleting a project nulls
   both pointers (`ON DELETE SET NULL`).
5. **The switcher never lists archived projects**, and `PATCH /preferences`
   refuses one for either pointer (422 `invalid_field`).
6. **One project control, in the header, at every width.** It sits next to the
	 wordmark on desktop and phone. At two or more live projects its compact
	 label is the focus; at zero or one it says Projects while its accessible
	 name still reports the focus. Focus choices are separate from the real-link
	 actions Open project (when focused), Manage projects (the remembered grid),
	 and New project (`/projects?new=1`). Archived projects are omitted.

	 **Responsive chrome boundary.** The three primary destinations — Issues,
	 Workflows, and Agents — move into the
	 header at 48rem (`md`); below that width they remain in the bottom bar so the
	 switcher and account control keep a valid width budget. Main content and
	 workflow import/export action bars reserve the bottom bar's full height and
	 safe-area inset on the same boundary. Browser coverage sweeps both sides of
	 the 40rem and 48rem edges so overflow cannot hide at a breakpoint.
7. **Available at every project count.** With no live projects the control
	 offers Manage projects and New project without an empty radio group. With
	 one, it also offers All projects and that project, but does not focus it
	 automatically. A sole project remains the separate New-issue default.
8. **New issue's default project:** the focus, else `last_project_id` (last
   focused or last created in), else — at two or more projects — an empty,
   required select. Never `projects[0]`.
9. **nav-memory** remembers the non-project Issues filters (category, workflow, state,
   label, q) per tab as before; it strips `project`, which would otherwise
   re-fire the one-shot on every click of the Issues tab.
   Issue-page Back keeps an Issues target, but keeps a remembered project page
   only when it matches the current focus.
10. **Agents and the CLI.** `GET`/`PATCH /api/v1/preferences` is control-plane
   fenced, reads included: a run key gets the same 403 as for runners and
   settings. Every API list stays unscoped whatever its owner's focus is.
11. **Client consistency.** An automatic project-page focus is optimistic, but
    subsequent same-origin fetched reads wait for its PATCH to settle. Explicit
    switcher choices queued during that write run afterward in click order. A
    failed automatic write rolls back its own hint before reads resume and may
    not erase a newer choice. Optimistic hints only resolve to projects still in
    the live layout list, so in-app archive immediately falls back to All
    projects. Explicit choices invalidate the shared `app:preferences`
    dependency while the page remains resident. If navigation is already
    waiting on the write, its destination load reads the persisted scope and
    the live hint keeps reused chrome aligned instead of racing a second
    invalidation against that navigation. Archive still refreshes the complete
    project inventory.

### Non-goals

- A CLI or agent default project, and focus as a permission or routing
  boundary.
- Remembering non-project filters server-side, or more than one focus at a time.
- Moving issues between projects, project membership (Tines/205), per-project
  labels, and project nesting.

### Moving an issue to another project (Tines/392)

Supersedes the non-goal above: an issue *can* be moved between projects, and a
move preserves everything but the address. `tines issues transfer <ref>
--project <dest>`, `GET/POST /api/v1/issues/:id/transfer` and the issue page's
"Move to project…" all drive one contract — preview, then commit the token that
preview returned. Project **focus** is still untouched by a move, and everything
else in the non-goals list (membership, per-project labels, nesting) stands.

1. **Identity.** The issue row keeps its ID; only `project_id`, `number`, an
   internal assignment token and `updated_at` change. Comments, artifacts and
   their versions and bytes, labels, links, runs, workflow/state/state-entry
   time, gate freshness, pins, attempts, parked status and schedule membership
   are never copied and never rewritten.
2. **Addresses.** Every number the issue has ever held is a permanent row in
   `issue_address`, which is also the allocator: ordinary creation, starters and
   scheduled instances all take `MAX(issue_address.number) + 1`, so moving the
   highest-numbered issue away cannot free its number for reuse. Old refs
   resolve for reads and authorized writes; old browser URLs canonicalize.
3. **Deletion.** A project that owns a historical address refuses deletion with
   `422 project_has_issue_aliases`, `--force-context` included, and offers
   archive instead.
4. **Authority.** Human sessions and ordinary named keys commit; a run key may
   read the preview and always gets `403 run_key_forbidden` on the POST.
   Archived source or destination, and an assigned/launching/running issue, are
   refusals with a remedy — never a drain or an automatic cancellation.
5. **Freshness.** The preview signs a witness of the move-relevant issue,
   context and configuration; the commit re-compares those exact SQL witnesses
   inside its guarded UPDATE. A change means `409 transfer_preview_stale` and an
   explicit new confirmation. Capacity, heartbeats and spending stay advisory.
6. **No allocation on preview.** Only the confirmed move takes a number, and a
   same-project request is a no-op: no number, no event, no token rotation.
7. **Receipt.** Success is established inside the guarded batch by the fresh
   assignment token and this request's transfer event, never by D1's aggregate
   affected-row count (which includes the address trigger). Human web and CLI
   reviews show retained guidance, effective repositories and overridden
   candidates, checkout conflicts, and both routing explanations before commit.
   Every ordinary routing remedy is actionable there: the web links to its
   supplied destination or shows its command, while the CLI prints the exact
   executable command. Checkout conflicts are identified by their exact
   directory plus sorted effective repository IDs, classified as retained,
   resolved or introduced, and name every participant with its side-specific
   scope (falling back to an unresolved ID).
