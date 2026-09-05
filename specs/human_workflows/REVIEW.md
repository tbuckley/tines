# Human workflows: a review of Tines as the human's tool

Tines was built so that agents can work an issue tracker; this review asks what the
same tracker should look like from the other chair. The human's job is not to get any
one feature right — agents do that — but to run a balanced organisation of agents: drop
work in and trust it will be handled, notice when the organisation itself changes, stay
on top of what changed, and spend limited attention where only a human can act.

It reads the code as of `main` at 310f62a (labels shipped, the issues list redesign
merged) and the specs under `specs/`. Part 1 is the diagnosis; Part 2 proposes changes,
grouped by the human need they serve, with directions and tradeoffs; Part 3 is a
suggested order. Nothing here is decided.

## Part 1 — What a human gets today

### The design intent

The specs are consistent about the human's role. Work bounces between humans and agents
"using nothing but the workflow graph, which is the *entire* automation boundary"
(`specs/supervisor/USER_FLOWS.md`, flow 6). Agents pick up `active` states and never
touch `awaiting_human`; moving an issue into a review column *is* the handoff. Comments
are the durable narrative, so "an issue's history is legible without ever opening a run
log." The human drives everything with two verbs, comment and transition, and the
happy-path touchpoints are "one board move at the start and one review at the end."

The specs also say, explicitly, that there is no inbox beyond a column: "No notification
on agent handoff to `awaiting_human` — single-user, so the awaiting-human column *is*
the inbox" (USER_FLOWS.md, flow 2). That decision was right when the fleet was one
runner on one project. It is the decision this review revisits.

### What the UI actually offers the human

Read from `apps/web/src/routes/(app)` and `apps/web/src/lib/components`:

- **No aggregation of "things waiting on me."** `awaiting_human` is a tab with a count
  on the Issues page (`IssueFilterBar.svelte`). Parked issues (`needs_attention`) are an
  amber chip on a row and a banner on the detail page; they cannot be filtered to and
  appear in no roll-up. Nothing in the global nav carries a count.
- **No notifications of any kind**, in-app, email, or push. The only email is the
  sign-in magic link. A parked issue, a runner error, a timed-out run, or an agent's
  question waits until someone opens the right page.
- **No "since I last looked."** `/activity` is a flat, newest-first firehose with a
  project and a type filter. It cannot be filtered by actor (human, agent, schedule,
  supervisor), even though every row renders the actor. Its type dropdown omits the
  automation events an operator most wants: `issue.parked`, `issue.resumed`,
  `agent_run.*`, `runner.*`, `routing_rule.*`, `context.*`, `settings.updated`.
- **No sorting** on the issues list; the order is newest-created first
  (`issues.ts:385`). Waiting time, last activity, and strikes are computed but not
  sortable.
- **No quick capture.** Creating an issue is a modal asking for project, title,
  description, labels, workflow, starting state, and recurrence. No shortcut, no
  title-only path, no "add another," no way to file from the detail or activity pages.
- **A dropped issue is either dispatched immediately or ignored.** The standard workflow's
  initial state `Open` is `active`, so an issue with a matching routing rule goes to an
  agent on the next pass with no triage; an issue in a project without a rule sits
  silently, and only the per-issue explainer says so.
- **The organisation is invisible as a changing thing.** Context items have a CAS
  `version` counter but no history and no diff (`specs/context/AGENT_EDITING.md`
  defers this). A `journal rewrite` replaces the body wholesale and leaves a
  `context.updated` event that says `changed: ['body']`. Routing, quota, and workflow
  edits are events with no before/after. There is no "what changed in how my agents
  work this week."
- **The real approval gate lives outside Tines.** For code work, the human's decision
  is the GitHub merge. Tines knows a `pr` artifact exists but not whether it is open,
  green, merged, or stale (`specs/artifacts/SPEC.md` defers "PR status integration").
  The consequence is visible in this repository: what looks like a daily scheduled docs audit files an
  issue each morning and an agent opens a PR for it, and six of those PRs (#44, #53,
  #72, #80, #90, #107) are open and unmerged. Recurring agent output is outrunning the
  human's review, and Tines has no view in which that backlog exists.
- **No run summary and no cost roll-up.** A run yields `outcome`, `error`, `usage`,
  and a raw log. Per-run cost is a JSON snapshot; `tines usage` and the usage ledger
  in the supervisor spec are unimplemented. "What did agents cost this week" is a
  script over `runs list --json`.

### What the agent contract makes impossible for humans

The agent side has gaps that become human problems:

- **Agents have no sanctioned way to ask.** The seeded guidelines put "questions" in
  comments. Nothing marks a comment as a question, nothing routes it, and the strike
  system judges a run only by whether it transitioned the issue (`engine.ts:779-793`).
  A run that leaves an honest "I need a decision" comment and correctly declines to
  move the issue scores identically to a crashed run. The only strike-free punt is a
  transition to an `awaiting_human` state, which exists only if the workflow author
  put one within reach of the current state.
- **Agents cannot offer alternatives.** One run per issue at a time, one artifact
  slot per name, no primitive for "here are two options, pick one."
- **Proposals are a title prefix.** `Context change: <scope>` issues are how agents
  propose organisational change. They have no link to the target item, no structured
  body, no Apply. The human re-types the change into the context editor.
- **No decomposition.** Links are `blocks` and `duplicate_of` only. An agent handed a
  task too large for one run can time out or hand back prose.

### The shape of the problem

The tracker is optimised for the *transaction*: one issue, one run, one transition.
Humans operate at the level of the *population*: what needs me, what changed, is the
organisation drifting, what is this costing. Every human need in the brief is a
population-level view, and none exists.

## Part 2 — Proposals

The proposals keep the product's stated principles: the workflow graph stays the
automation boundary, comments stay the narrative, Tines injects no directive text of
its own, automation stays opt-in, and the affordance asymmetry between humans and run
keys is preserved. Where a proposal needs schema, it is additive.

### 2.1 Quick capture with trusted triage

**Need.** Drop an issue in seconds and trust it lands in the right place.

**Direction A — a triage stage, on existing rails.** Add a workflow template whose
initial state is `Triage` (category `active`), routed by a state-scoped rule to the
`cheapest` tier, with state-scoped instructions: dedupe against open issues, apply
labels from the vocabulary, tighten the title and description, split into linked issues
if too big, then move to `Ready` (active), `Backlog`, or `Needs clarification`
(`awaiting_human`) with a comment saying what was done and why. Ship it as a second
system workflow ("Standard with triage") or as an importable library entry. This needs
no code: state-scoped context, per-state routing, labels, and links all exist. A
transition requirement of "a comment from this run" (the future work item in
USER_FLOWS.md) would guarantee the acknowledgement.

- Tradeoff: every issue costs one cheap run, and the triage agent's judgement is where
  errors land. Pair it with the digest (2.3) so mis-triage is visible daily.

**Direction B — capture UI.** A single-line capture box at the top of the Issues page
and a global keyboard shortcut (`c`) that takes a title and optional body, files into a
remembered default project, and stays open for the next one. Same thing on the CLI as
`tines add "<title>"`. Optional: an email-in address using Cloudflare Email Routing to a
worker `email()` handler, and a PWA share target for the phone.

- Tradeoff: capture without choosing a project means triage must be able to move an
  issue across projects, which the per-project numbering does not allow. Recommendation:
  capture always names a project (defaulting to the last used one, one tap to change);
  cross-cutting thoughts go to an "Inbox" project whose triage instructions say to
  refile by creating a new issue in the right project and marking the original as a
  duplicate of it.

**Recommendation.** Both. A is the triage guarantee; B removes the modal from the
common path. The modal stays for the deliberate case.

### 2.2 Observing organisational change

**Need.** The human is building a society, so the things that shape agent behaviour
(context items, journals, workflows, routing, quotas, schedules, labels) need to be
watchable as they change, especially when agents change them.

**Direction A — history and diffs for context items.** Add a `context_item_version`
table capturing body and files on every write, with actor and timestamp. Render a diff
in the activity feed row and in the item editor, with **Revert**. Journals are the one
shared thing agents rewrite freely; today the previous text is simply gone.

- Tradeoff: storage grows with every journal append (bounded: journals are short by
  instruction; prune versions older than N days or keep the last 50). One migration,
  additive. This is the highest-value observability change in this review because it
  turns "agents can silently rewrite shared memory" into "agents can rewrite it and I
  can see and undo it."

**Direction B — an organisation feed.** A preset on `/activity` (or its own tab,
"Changes") that shows only control-plane events (`context.*`, `workflow.*`,
`routing_rule.*`, `settings.updated`, `scheduled_task.*`, `label.*`, `runner.*`) with an
**actor kind** filter: you, a named key, an agent run, a schedule, the supervisor. The
supervisor and schedule sweeps currently write events with `actor_api_key_id = NULL`,
indistinguishable from a browser session; add an `actor_kind` column to `event`
(`session | api_key | run | supervisor | schedule`) and backfill from type. Also fix the
type dropdown to list every known type.

- Tradeoff: small migration, mostly UI. Without A the feed still only says "body
  changed."

**Direction C — proposals as a first-class object.** Keep the spec's design (a
proposal is an issue reviewed in its thread) but make it structured: an agent files
the proposal with `tines context propose <item> --body @file`, which creates the issue
*and* attaches a `text` artifact named `proposal` whose config records the target
item id and the base version. The issue page renders the diff against the item's
current body with **Apply** and **Reject** buttons; Apply writes the item (CAS on the
base version), comments, and transitions the issue to done. This also gives the
curator agent in `AGENT_EDITING.md` a structured thing to judge later.

- Tradeoff: uses artifacts and issues rather than a new table, so it rides existing
  rails; the cost is a convention (`proposal` artifact name, config keys) that the
  issue page must recognise. Alternative: a `proposal` table with its own endpoints,
  cleaner but a new subsystem.

**Direction D — journal governance per stage.** A per-state setting for how agents
may touch the journal: free (today), append-only, or rewrite-as-proposal.

- Tradeoff: adds a knob and friction; with A in place, free writes plus diff and revert
  are probably enough for a single operator. Defer unless the feed shows abuse (the
  tripwire `AGENT_EDITING.md` already names).

**Recommendation.** A and B now, C when proposals become frequent, D never unless
needed.

### 2.3 Staying on top: gates, digests, notifications

**Need.** Know what changed without reading everything, and choose per kind of change
whether to approve it up front or review it after the fact.

The two directions here are complementary, not competing. Gates trade latency and
human load for control; digests trade control for throughput and need good undo. The
balanced-society framing suggests: **gate changes to the organisation** (context,
workflows, routing, budgets), **digest and spot-check the work** (features, docs,
fixes), and let the gate placement per stage move as trust grows.

**Decision (2026-09-05): digests wait.** Today every issue passes through an
`awaiting_human` gate, and every code change through a GitHub merge, before it counts.
While that holds, the approval queue *is* the complete record of change, and a digest
would only restate what the Inbox (2.4) already lists. Digests become necessary at the
moment work starts landing in `active` states without a human placing it there: issues
created by schedules straight into `Open`, a triage stage (2.1 A) that promotes to
`Ready` on its own, or quick capture defaulting to an active state. That moment is a
deliberate choice, and shipping the digest should be part of making it. Until then,
directions B and C below are recorded, not scheduled; A stays current.

**Direction A — gates stay in the graph, but the graph gets templates.** The
mechanism exists: an `awaiting_human` state between stages. What is missing is
guidance. Ship two or three system workflow templates that encode trust levels
("Supervised": every stage gated; "Autonomous": gated only before done; "Triage +
autonomous": gated only at intake) so moving a project between trust levels is one
setting change, not a workflow edit.

- Tradeoff: templates are opinionated; users with their own workflows ignore them.
  Cheap to ship.

**Direction B — a deterministic digest with a watermark.** Add `last_caught_up_at` per
user (one column on the user or a tiny table). A `/digest` page renders everything
since that watermark, grouped by project then issue: created (by whom), transitions,
parked, resumed, comments by agents (count and first line), artifacts attached, PRs
opened, runs (count, cost, outcome), and a separate **organisation changes** section
from 2.2. "Mark caught up" advances the watermark; the nav shows "N changes since you
last caught up." The same renderer produces an email on a schedule (daily at a chosen
hour) through the existing `EMAIL` send binding and the existing cron sweep. Comment
bodies are not in event payloads by design, so the digest joins `comment` for the
first line.

- Tradeoff: no LLM, so always accurate and free; but it is a list, not a narrative.
  The events endpoint needs a forward `since` cursor (today it only pages backwards).

**Direction C — an agent-written digest, zero code.** A scheduled task ("Daily
digest", 07:00, `require_all_closed`) in an "Ops" project, with state-scoped
instructions to run `tines events list --all-pages`, read the threads that changed,
and post a narrative comment: what shipped, what is stuck and why, what is waiting on
the human, what changed in shared context. This works today.

- Tradeoff: costs a run per day, can be wrong or bland, and the human has to open an
  issue to read it. It is the fastest way to find out whether narrative digests are
  worth building for real. When digests become necessary: try C first for a week,
  build B regardless because the watermark also serves the Inbox, and if C's
  narrative earns its keep, embed the latest digest comment at the top of B's page.

**Direction D — notifications, batched and opt-in.** Push or email for a short list
of high-signal events: issue parked, issue arrived in `awaiting_human`, runner
errored, a question asked (2.5), budget exceeded. Batch to at most one message per
hour with a link to the Inbox; per-type opt-in in Settings.

- Tradeoff: interrupts versus latency. Batching is the compromise; a single operator
  checking an Inbox twice a day may not need this at all once 2.4 exists.

### 2.4 Focus: an Inbox that answers "what needs me"

**Need.** With limited time, see only the items where a human is the only possible
actor, ordered by how long they have waited, and act on them without opening each
issue.

**Direction A — an `/inbox` page that is the signed-in home.** Sections in fixed
order, each with a count, each row carrying its wait time and inline actions:

1. **Questions** — issues with an unanswered question (2.5). Action: pick an option or
   type an answer; posts the comment and transitions back in one gesture.
2. **Awaiting your decision** — issues in `awaiting_human` states. Action: the state's
   transitions as buttons (Approve, Send back) with the optional comment field the
   transition dialog already has; for issues with a `pr` artifact, the PR link and its
   status (2.6).
3. **Parked** — `needs_attention`, with the last run's error and a Resume button, and
   a "Send back with instructions" that comments and transitions.
4. **Proposals** — `Context change` issues, with Apply / Reject (2.2 C).
5. **Nothing will happen** — issues in an active state with no matching rule, no pin,
   automation off, or a runner that has been backing off for over an hour. These are
   the silent failures the per-issue explainer already computes; the Inbox runs it in
   bulk.
6. **Stale** — active issues whose last activity is older than a threshold.

A nav badge shows the total of sections 1 to 4. Keyboard: `j`/`k` to move, `a` to take
the first forward transition, `s` to send back, `o` to open. Works on the phone; the
existing phone transition bar is the pattern.

- Tradeoff: a new surface built from the existing list components and the existing
  explainer, so mostly UI and one aggregate query. It duplicates some of the Issues
  page; the answer is that Issues is the map and Inbox is the to-do list.

**Direction B — a "Needs you" tab on the Issues page.** Cheaper: one more category
tab that unions `awaiting_human` and parked, sortable by wait time, with inline
transitions on the row.

- Tradeoff: no sections, no explainer-driven "nothing will happen," no proposals or
  questions. Good first step if A is too much at once; A can grow out of it.

**Direction C — time-boxed review.** Each Inbox row shows an effort hint set by the
agent at handoff (a `review:quick` / `review:deep` label from the vocabulary, applied
by the state instructions) so "I have ten minutes" is a filter.

- Tradeoff: relies on agents labelling honestly; costs nothing to try since labels
  exist.

**Recommendation.** A, built as B first if scope is a concern. The badge and the
"nothing will happen" section are the two pieces with no substitute today.

### 2.5 Questions, clarifications, and choosing between outputs

**Need.** Agents need a sanctioned, strike-free way to ask; humans need to answer in
one gesture; sometimes the answer is a choice between concrete alternatives.

**Direction A — a `kind` on comments.** Add nullable `kind` (`note | question |
answer | handoff`) and `meta` JSON to `comment`. `tines issues ask <ref> "<question>"
[--option A --option B ...] [--move "<transition>"]` posts a `question` comment with
options in `meta` and, in the same batch, takes the named transition (defaulting to the
first transition into an `awaiting_human` state if exactly one exists). The run is
judged `advanced`, so asking never costs a strike. The Inbox renders options as
buttons; answering posts an `answer` comment referencing the question and takes the
return transition. The launch prompt's comment listing marks questions and their
answers so the next run sees the resolution first.

- Tradeoff: one additive migration and a CLI verb. The alternative is a convention
  (a `## Question` heading) with zero schema, but then the Inbox cannot reliably
  render options and the strike system cannot recognise a deliberate punt when no
  `awaiting_human` transition is reachable. Recommendation: the column.

**Direction B — a guaranteed way out of every active state.** Workflow validation
warns today on dead ends. Extend the warning: an `active` state with no transition to
an `awaiting_human` state is a place agents cannot ask from. The templates in 2.3 A
include one.

- Tradeoff: warning only, no behaviour change. Cheap.

**Direction C — competing outputs.** Two ways to get alternatives to choose between:

- *Sequential, on existing rails:* a stage whose instructions say "attach your
  proposal as artifact `option-<n>` where n is the next free number, then Submit for
  review"; run it twice by sending back once with the comment "produce a different
  approach." The Inbox shows the `option-*` artifacts side by side; choosing one
  reaffirms it as `chosen` (a transition requirement on the forward transition). No
  code beyond the side-by-side view.
- *Parallel, new supervisor capability:* a per-state `samples: N` in the quota roster
  that lets N runs claim the same issue at once, each attaching `option-<run>`; the
  issue re-enters the pool only when all N have ended. Costs N runs and changes the
  one-run-per-issue invariant in the claim statement and the end judgment.

- Tradeoff: sequential is free and slower; parallel is faster, N times the cost, and
  touches the most delicate code in the supervisor. Recommendation: sequential plus the
  side-by-side view first; parallel only if the human finds themselves asking for
  alternatives routinely.

### 2.6 What else a human running an agent organisation wants

These were not in the brief but follow from it.

- **PR status in Tines.** Poll `pr` artifacts (open, checks, mergeable, merged, closed)
  with the stored PAT on the sweep. Show status in the Inbox and on the issue; allow a
  transition requirement "PR merged" so the graph can advance on merge without a human
  transition; let a scheduled cleanup close superseded PRs from the same schedule. This
  is what turns the six stale docs PRs from an invisible backlog into six Inbox rows,
  or, better, into one row after the cleanup.
- **A trust dial with evidence.** Per workflow state, show the last N runs: advanced
  versus stalled, cost per advance, average duration. The supervisor spec calls this
  outcome-rate analytics and defers it. It is what lets a human decide to remove a
  gate, and it is a query over `agent_run` that already stores `outcome`.
- **Cost roll-up.** A usage ledger (spec'd, unimplemented) or, cheaper, a weekly line
  in the digest: cost by project, by state, by runner, from `agent_run.usage`.
- **Spot-check sampling.** An "Audit" button on the Inbox that picks three random
  issues closed by agents since the watermark. Each has "Looks good" and "Flag," where
  Flag files a linked follow-up issue with the human's note. Agents are audited without
  every closure being gated.
- **Schedule hygiene.** Recurring audits are the likeliest source of review debt.
  Schedules should show their instances' fate (open PRs, unmerged for N days) on the
  project page, and a schedule whose last three instances are all still open should
  say so in the digest.
- **Undo for organisational edits.** Revert for context versions (2.2 A); for routing
  rules and settings, the event payload already carries before/after, so a "restore"
  on the event row is cheap.
- **Bulk actions.** Multi-select on Inbox rows for Resume, Approve, Send back, label.
  Ten parked issues after a runner outage should be one click.

## Part 3 — Suggested order

The order follows from the decision in 2.3: while every issue is gated, the bottleneck
is the human's approval queue, so the work that pays first is whatever makes that queue
visible, complete, and fast to act on. The six unmerged docs PRs are the measure.

**Week 1, no schema.** Ship the "Needs you" tab or a first Inbox (2.4 B or A) with the
nav badge; its "Awaiting your decision" section is the approval queue. Show the `pr`
artifact's link on each row so approval and merge are one visit. Ship the quick-capture
box (2.1 B) landing in `Backlog` by default, since capture into an active state is the
auto-pickup regime 2.3 defers. Fix the activity type list. Add the dead-end warning for
active states with no way to ask (2.5 B).

**Week 2 to 3, small additive migrations.** PR status polling on the sweep (2.6), so
the Inbox shows open, green, merged, or stale next to each awaiting issue and a "PR
merged" requirement can close the loop. `comment.kind` and `tines issues ask` (2.5 A).
`context_item_version` with diff and revert (2.2 A). `event.actor_kind` and the
organisation feed with actor filter (2.2 B).

**When work starts being picked up automatically.** This is the trigger for the rest,
and the triage stage (2.1 A) is the likeliest first cause of it. Ship together: the
triage workflow template; the watermark and the deterministic `/digest` page, then its
email (2.3 B), with the agent-written digest (2.3 C) as the cheap trial; batched
notifications (2.3 D) only if the Inbox and digest leave a gap.

**Later, when the volume justifies it.** Structured proposals with Apply (2.2 C).
Outcome stats per state and the cost roll-up (2.6). Side-by-side options, then parallel
samples only if wanted (2.5 C). Spot-check sampling (2.6) once closures stop being
individually approved.

## Open questions for the decision

1. Should the Inbox replace `/issues` as the signed-in home, or sit beside it?
2. Deferred with the digest: is its unit the day, or the human's own "mark caught up"
   gesture? The watermark design supports both; the email needs a clock.
3. Should questions be a comment kind (proposed) or a fourth link kind? Comments keep
   the thread as the narrative; links would make "blocked on a human" visible in the
   readiness model. Both could be true; the comment is the smaller change.
4. Does the human want gates on organisational change enforced (proposals only, run
   keys fenced from broad context writes) or observed (free writes with diff and
   revert)? This review recommends observed until the feed shows a reason to enforce,
   which is the tripwire `AGENT_EDITING.md` already set.
