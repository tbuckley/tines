# Tines — Scheduled Tasks Spec

Some work recurs: check the error dashboard every morning, rotate credentials monthly, triage the inbox every Friday. **Scheduled tasks** make the tracker create these issues on a schedule instead of relying on a human to remember. A scheduled task is a template plus a recurrence: at each occurrence, Tines renders the template into a normal issue in the task's project. The created issues are ordinary issues in every way — same workflows, transitions, comments, and events — so agents pick them up exactly as they pick up human-created work.

Creating one is part of the normal issue-creation flow: set an optional recurrence when creating an issue, and that first issue is created immediately while a schedule takes over from there.

## Goals

- Recurring issue creation on simple presets (hourly / daily / weekly / monthly) or a cron expression, evaluated in a per-schedule timezone.
- An optional gate: only create a new instance when all previous instances from the same schedule are closed.
- Placeholders in the title and description templates (`{{date}}`, `{{time}}`, …) rendered at creation time.
- Full lifecycle management — list, edit, pause/resume, run now, delete — in both the web UI and the CLI.
- Reliable execution without traffic, via a Cloudflare Cron Trigger.

## Non-goals

- **End conditions**: no end date, no max-occurrence count. Schedules run until paused or deleted.
- **Catch-up/backfill**: missed occurrences (worker downtime, gated occurrences) are never queued or replayed. At most one issue is created per schedule per sweep.
- **Editing past instances**: changing a schedule's templates affects future issues only.
- **Custom placeholder variables**: the placeholder set is fixed; no user-defined variables or format strings (`{{date:FMT}}` may come later).
- **Notifications**: no email/push when a scheduled issue is created; it appears in the Issues tab and activity feed like any other issue.
- **Sub-hourly recurrence**: schedules that would fire more often than once per hour are rejected (guardrail against accidental floods; the tracker is not a job queue).
- **Cross-project or multi-issue schedules**: one schedule belongs to one project and creates one issue per occurrence.

## Concepts

### Scheduled task

A per-project entity owned (like everything else) by the project's user. It has:

- **Name**: required, unique within its project — schedules are addressed as `<project>/<name>` in the CLI. The UI defaults it to the title template.
- **Templates**: a title template (plain text) and description template (Markdown), both supporting placeholders (below).
- **Workflow binding**: chosen at schedule creation exactly like issue creation (project default, else standard workflow), and editable afterwards. Each created issue is bound to this workflow and starts in the schedule's **start state** — by default the workflow's initial state (stored as NULL, so the schedule follows the workflow if its initial state changes), or a specific state pinned at creation (a non-initial starting state on the first issue pins the schedule too) or by editing the schedule. Changing the workflow resets the start state to the new workflow's initial state unless the same edit picks one. A workflow cannot be deleted while a schedule references it, and a state cannot be deleted while a schedule starts instances in it (extends the phase-one editing rules).
- **Recurrence**: a preset or raw cron expression, plus an IANA timezone (below).
- **Gate** (`require_all_closed`): when set, an occurrence only creates an issue if every previous instance from this schedule is in a `done`-category state.
- **Enabled flag**: paused schedules keep their configuration and history but never fire.
- Bookkeeping: `next_run_at` (precomputed next occurrence, drives the sweep), `last_run_at`, and `run_count` (number of issues created by this schedule, including the initial one).

### Recurrence

Users express recurrence as either a **preset** or a **cron expression**; both are stored, and presets are compiled to cron so evaluation has a single path:

| Preset | Inputs | Compiles to |
| --- | --- | --- |
| Hourly | every N hours (1–23) + minute past the hour | `M */N * * *` (`M * * * *` for N=1) |
| Daily | time of day | `M H * * *` |
| Weekly | weekday + time of day | `M H * * D` |
| Monthly | day of month + time of day | `M H DOM * *` |
| Custom | raw 5-field cron | as given |

The hourly preset follows cron `*/N` semantics: the cycle restarts from hour 0 each day, so an N that doesn't divide 24 has a shorter final interval before midnight. N=1 (every hour) sits exactly at the flood guardrail and is allowed.

- Cron is the standard 5-field form (minute, hour, day-of-month, month, day-of-week) supporting `*`, numbers, ranges, lists, and steps. Expressions whose minimum interval is under one hour are rejected with a 422.
- Every schedule stores an **IANA timezone**, defaulting to the creator's (browser timezone in the web UI, system timezone in the CLI). The cron expression is evaluated in that timezone, so "daily at 9:00" means local 9:00 across DST changes. Spring-forward gaps: a nonexistent local time fires at the next valid instant; fall-back ambiguity: the occurrence fires once, at the first instant. Monthly day-31 in a short month follows cron semantics: that month is skipped.
- `next_run_at` is recomputed (from cron + timezone) whenever the schedule is created, its recurrence or timezone edited, it is resumed, or an occurrence fires.

### Occurrences and the gate

When an occurrence comes due (see Execution), the sweep either **creates** an issue or **skips**:

- **Gate check**: with `require_all_closed` set, the occurrence is skipped if any issue linked to this schedule sits in a state whose category is not `done`. Skips are terminal — the occurrence is recorded as skipped (a `scheduled_task.skipped` event naming the blocking issues) and is never retried; the next issue appears at the next scheduled occurrence after the blockers close.
- **Collapse**: if multiple occurrences have elapsed since the last sweep (downtime, a long pause), at most one issue is created and `next_run_at` advances to the next *future* occurrence. Missed intermediates are silently collapsed.
- **Creation**: the templates are rendered, and an issue is created through the same server path as manual creation — number allocation, initial state, and `issue.created` event included.

### Instance linkage

Issues created by a schedule carry a nullable `scheduled_task_id` back-reference. This drives:

- the gate check ("all previous instances closed" = no linked issue in a non-`done` state),
- a badge on scheduled issues in lists and detail views, linking to the schedule,
- an "issues from this schedule" filter.

Deleting a schedule keeps its issues; their `scheduled_task_id` is nulled (the `issue.created` event payload retains the schedule's id and name for history). The initial issue created alongside the schedule is linked like any other instance — it counts for the gate and for `{{count}}`.

### Placeholders

Title and description templates support a small fixed set of mustache-style tokens, rendered at issue-creation time in the **schedule's timezone**:

| Token | Renders as | Example |
| --- | --- | --- |
| `{{date}}` | ISO date | `2026-08-23` |
| `{{time}}` | 24-hour time | `09:00` |
| `{{datetime}}` | date + time | `2026-08-23 09:00` |
| `{{schedule_name}}` | the schedule's name | `Daily error triage` |
| `{{count}}` | 1-based instance number | `14` |

Unknown or malformed tokens are left as-is (they are probably literal Markdown, and silently eating text is worse than rendering `{{oops}}`). Whitespace inside braces is tolerated (`{{ date }}`). Rendering happens for every instance, including the initial issue created with the schedule and run-now instances — the timestamp used is the creation time, not the nominal occurrence time.

### Actor attribution

Scheduled creation runs with no session and no API key, but events require an actor. Issues and events created by the sweep are attributed to the **owning user** with `actor_api_key_id` NULL, and the `issue.created` payload carries the `scheduled_task_id` (plus the schedule name). The UI renders these as "via schedule *name*" — parallel to "via *api-key-name*" — so scheduled work stays distinguishable from both human and agent work in the log.

### Events

New event types (open string types, no migration needed):

- `scheduled_task.created`, `scheduled_task.deleted`
- `scheduled_task.updated` — summary-diff payload like `workflow.updated`, covering template/recurrence/gate changes and enabled toggles (`{ enabled: { from, to } }` for pause/resume)
- `scheduled_task.skipped` — payload: the blocking issues (`[{ issue_id, number }]`) and the nominal occurrence time

Plus payload extensions: `issue.created` gains optional `scheduled_task_id`, `scheduled_task_name`, and `manual: true` for run-now instances.

## Data model (D1 / Kysely)

One new table and one new column, in a new numbered migration:

```
scheduled_task  id, project_id, name, title_template, description_template, workflow_id,
                state_id?,   -- start state; NULL = the workflow's initial state (ON DELETE SET NULL)
                cron, preset(JSON)?, timezone, require_all_closed, enabled,
                next_run_at, last_run_at?, run_count, created_at, updated_at
                -- unique on (project_id, name); index on (enabled, next_run_at) for the sweep
issue           + scheduled_task_id?   -- ON DELETE SET NULL
```

Notes:

- `preset` is the round-trippable form for the UI (`{ kind: 'hourly'|'daily'|'weekly'|'monthly', time?, weekday?, day_of_month?, every_hours?, minute? }`); NULL means raw cron. `cron` is always populated (presets compile to it) and is the only thing evaluation reads.
- `require_all_closed` and `enabled` are 0/1 integers; timestamps are ms-since-epoch as elsewhere.
- `run_count` increments in the same transaction as each linked issue creation; `{{count}}` renders `run_count + 1` for the issue being created.
- Deleting a project deletes its schedules (project deletion already requires the project to be issue-less; schedules go with it, emitting `scheduled_task.deleted`).

## Execution

A **Cloudflare Cron Trigger** sweeps for due schedules:

- `wrangler.jsonc` gains `triggers: { crons: ["*/30 * * * *"] }`. The worker entry becomes a small custom module that re-exports the SvelteKit-generated worker's `fetch` and adds a `scheduled()` handler (the adapter's `_worker.js` alone has no scheduled hook). The handler calls sweep logic living in `lib/server/` with the same D1 binding.
- **Sweep**: select schedules where `enabled = 1 AND next_run_at <= now`, then per schedule, in one transaction: re-check due-ness, run the gate check, create the issue (or emit `scheduled_task.skipped`), update `last_run_at`/`run_count`, and advance `next_run_at` to the next future occurrence. Advancing `next_run_at` transactionally is what makes overlapping sweeps harmless — a second sweep no longer sees the schedule as due. One schedule failing must not abort the rest of the sweep.
- **Effective resolution**: an occurrence fires at the first sweep at or after its nominal time, so creation timestamps lag the schedule by up to the sweep interval. With the sub-hourly guardrail this is negligible.
- **Local dev / e2e**: `wrangler dev --test-scheduled` exposes `GET /__scheduled?cron=…` to fire the handler on demand; the e2e suite uses this to test the sweep deterministically (no clock-dependent waits — seed schedules with `next_run_at` in the past and trigger a sweep).

## API

Same conventions as phase one: `/api/v1/*`, session or bearer key, user-scoped (cross-user = 404), cursor pagination, structured 422s. Shared types in `@tines/shared`.

| Method & path | Purpose |
| --- | --- |
| `POST /api/v1/projects/:id/issues` | Extended: optional `schedule` object (`name?`, `preset` or `cron`, `timezone?`, `require_all_closed?`) — creates the first issue immediately (templates rendered, linked to the schedule) *and* the schedule; response includes both |
| `GET /api/v1/schedules` | Global list across projects; filters: `project`, `enabled` |
| `GET /api/v1/projects/:id/schedules` | List a project's schedules |
| `GET/PATCH/DELETE /api/v1/schedules/:id` | Read (incl. next/last run, run count, open-instance count) / update any field incl. `workflow_id`, `state` (id or name; null or the initial state = follow the workflow), and `enabled` (pause = `{ enabled: false }`) / delete |
| `POST /api/v1/schedules/:id/run` | Run now: create an instance immediately. Respects the gate — blocked returns a 422 naming the open instances. Does **not** change `next_run_at`; works on paused schedules |
| `GET /api/v1/issues` (+ project-scoped list) | New filter: `schedule=<id>` for "issues from this schedule" |

Validation (422 with specifics): invalid cron / unknown timezone / sub-hourly interval; duplicate schedule name in project; empty title template; workflow not in the user's library. In the create-issue call, the issue's title/description double as the templates.

## CLI

Recurrence flags on `issues create`, plus a `schedules` command group. Schedules are addressed as `<project>/<name>`.

```
tines issues create <project> -t <t> [-d <md>] [-w <wf>]
    [--every <hourly|Nh|daily|weekly|monthly>] [--at <HH:MM|:MM>] [--on <weekday|day-of-month>]
    [--cron "<expr>"] [--tz <iana>] [--if-closed] [--schedule-name <name>]
        # --every/--at/--on build a preset; --cron is the raw alternative (mutually exclusive)
        # --if-closed sets require_all_closed; --tz defaults to the system timezone
        # --schedule-name defaults to the title; creates the first issue now + the schedule

tines schedules list [--project <name>] [--all]      # hides paused unless --all
tines schedules show <project>/<name>                # config, next/last run, recent instances
tines schedules edit <project>/<name> [--title <t>] [--description <md>]
    [--workflow <wf>] [--state <state>]
    [--every …] [--at …] [--on …] [--cron …] [--tz …]
    [--if-closed | --no-if-closed] [--name <new-name>]
tines schedules pause | resume <project>/<name>
tines schedules run <project>/<name>                 # run now; prints the created issue ref
tines schedules delete <project>/<name>              # confirms unless --yes
```

All commands support `--json`. `schedules show --json` includes `next_run_at`, `open_instances`, and the compiled cron, so an agent can reason about a schedule without parsing prose.

## Web UI

### New Issue modal — "Repeat" section

A collapsed "Repeat" section at the bottom of the existing modal (title/description/workflow above it are untouched — they double as the templates):

- Repeat picker: **Never** (default) / Daily / Weekly / Monthly / Custom cron — revealing time-of-day, weekday or day-of-month, or a cron input as appropriate, plus a timezone select defaulting to the browser's.
- Checkbox: *Only create when previous instances are closed.*
- A live summary line ("Every Monday at 9:00, Europe/London — next: Aug 25") so the user sees what they configured; invalid cron surfaces inline.
- Submitting with a recurrence creates the issue (placeholders rendered) and the schedule; the button label switches to "Create issue + schedule" when a recurrence is set.

### Project page — Scheduled tasks section

A "Scheduled tasks" section on the project detail page (hidden when the project has none, with a small "add" affordance that opens the New Issue modal with Repeat expanded):

- Rows: name, human-readable recurrence, next run (relative), last run, open-instance count, enabled toggle.
- Row actions: **edit** (modal reusing the Repeat form plus template fields), **run now**, **delete** (confirm dialog; notes that existing issues are kept).
- Pause/resume is the inline toggle; state changes animate per the phase-one motion rules (toggle morph, row dims when paused).

### Scheduled issues elsewhere

- Issue rows and the issue detail page show a small repeat icon/badge on issues with a `scheduled_task_id`, linking to the schedule (the project page section, row highlighted and — since Tines/146 moved the section below the issue list — scrolled into view).
- The activity feed renders `scheduled_task.*` events and shows scheduled creations as "via schedule *name*".

## Acceptance criteria

1. Create an issue in the web UI with "Daily at 9:00" and *only when closed* set: the issue appears immediately with `{{date}}` in its title rendered to today's date, and the project page shows the schedule with the correct next run.
2. Fire the sweep (via `--test-scheduled` locally) past the next occurrence with the first issue still open: no issue is created, and a `scheduled_task.skipped` event names the blocker. Close the issue, fire past the following occurrence: the next instance appears, attributed "via schedule …" in the activity feed.
3. `tines issues create demo -t "Weekly report {{date}}" --every weekly --on monday --at 09:00` creates the issue and the schedule; `tines schedules list --project demo` shows it; `edit`, `pause`, `resume`, `run`, and `delete` all work and emit the corresponding events, and `run` on a gated schedule with open instances fails with a 422 naming them.
4. Editing a schedule's recurrence updates `next_run_at`; pausing stops firing; resuming recomputes the next occurrence from now (no backfill of the paused span).
5. Deleting a schedule keeps its issues (badge gone, history events intact); deleting a workflow referenced by a schedule is rejected with a clear error.
6. Multiple missed occurrences collapse to at most one created issue per sweep.

## Resolved questions

- **Recurrence form**: presets + raw cron, each schedule carrying an IANA timezone defaulting to the creator's — "daily at 9am" means local 9am. Presets compile to cron; only cron is evaluated.
- **Gate semantics**: with `require_all_closed`, a blocked occurrence is **skipped**, not deferred or queued — recorded via `scheduled_task.skipped`, and any linked issue in a non-`done` state blocks (not just the latest).
- **Placeholders**: fixed mustache-style set (`{{date}}`, `{{time}}`, `{{datetime}}`, `{{schedule_name}}`, `{{count}}`), fixed formats, rendered in the schedule's timezone; unknown tokens pass through untouched.
- **Execution**: Cloudflare Cron Trigger every 30 minutes with a custom worker entry wrapping the SvelteKit handler; no lazy on-request fallback (dev and e2e use `--test-scheduled`). Concurrency handled by transactionally advancing `next_run_at`.
- **Linkage**: nullable `scheduled_task_id` FK on `issue`, `SET NULL` on schedule deletion; event payloads preserve the schedule's identity for history.
- **Lifecycle**: pause/resume via an `enabled` flag plus a run-now action (gate-respecting, `next_run_at` untouched), alongside deletion.
- **Creation flow**: setting a recurrence during issue creation creates the first issue immediately *and* the schedule — the form's fields double as the templates.
- **UI placement**: managed in a per-project "Scheduled tasks" section (no global schedules page yet); scheduled issues carry a badge.
- **Attribution**: sweep-created issues/events are attributed to the owning user with the schedule identified in the payload, displayed as "via schedule *name*".
- **Flood guardrail**: recurrences firing more often than hourly are rejected at validation time.

- **2026-09-10, Tines/392 — a moved instance keeps its schedule**: transferring an instance to another project does not detach it. It keeps `scheduled_task_id`, still blocks its schedule's closure gate until it is done, and links back to the schedule in the schedule's *own* project. Future instances continue to be created there, with a number taken from that project's address ledger — never a number a moved issue once held.
