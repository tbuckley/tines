# Tines — Product Management Workstreams Spec

The scheduled runs that exist today (QA, Design Audit, Docs Audit, Architecture, Ideation) all look *inward*: they study the code and the tracker and file engineering work. Nothing looks *outward* from a user's seat and asks what the product should become. This spec adds **product-manager agents**: several PMs, each owning one **workstream** with a named target user, that pitch concepts, write PRDs a human iterates on, and — once a PRD is approved — file the engineering issues to deliver it and see the direction through to shipped.

It is built entirely from existing primitives: workflows with artifact-gated transitions, blocking links and readiness, labels, state-scoped instruction prompts, scheduled tasks, and routing. **No code changes ship with this spec.** Set up on 2026-09-05 through the CLI against production; the one code dependency (label-scoped context, Tines/168) is tracked by Tines/182.

## Goals

- Multiple PMs, each with a clear target user and explicit boundaries against its neighbours, so five agents do not pitch the same feature or wander into each other's areas.
- A pitch → PRD → review loop where the human steers with comments and the PM revises until aligned.
- Delivery driven by the tracker itself: the direction issue is blocked by the engineering issues that implement it and is only dispatched when they are all done, at which point the PM ships, plans the next tranche, or asks for a decision.
- Every PM run ends in a transition, because the supervisor judges a run *advanced* only when its run key transitioned the issue; a run that only comments is a strike.
- Human effort concentrated at two cheap gates — picking pitches and reviewing PRDs — with everything else automated.

## Non-goals

- **A PM entity or role.** A workstream is a label plus a charter document; a PM is whatever runner the routing rules send the PM states to.
- **Metrics.** Success signals in a PRD are observable behaviours a run can verify by using the product, not analytics the product cannot measure.
- **Engineering process changes.** Filed issues go through the existing Engineering workflow unchanged.
- **Cross-project workstreams.** Directions and their engineering issues live in the same project as the product they describe.

## Concepts

### Workstream = label + charter

A workstream is one product area with one target user. It is represented by:

- **A label** (`onboarding`, …) carried by every issue in the workstream: discovery runs, direction issues, and the engineering issues filed under them. `tines issues list -l <label>` is the whole workstream; adding `-w` narrows to one layer of it.
- **A charter**: the standing brief every PM run works under. Six sections, in order:
  1. **Target user and moment** — who, in what situation; specific enough to walk the product *as* them.
  2. **Owns** — the surfaces and jobs the workstream may propose changes to.
  3. **Does not own** — the neighbouring workstreams by name, with the hand-off rule: a concept that belongs to a neighbour is filed as a pitch carrying the neighbour's label, never pursued here.
  4. **Evidence sources** — flows to walk in the running app, docs and specs to read, which audit reports and journals matter.
  5. **Limits** — `max in flight` (directions in Drafting/PRD Review/Planning/Delivering at once; default 2), `pitches per run` (default 2, max 3), `tranche size` (open blockers per direction at once; default 3, a ceiling not a target), `issue size` (default ~2,000 lines of hand-written change per issue; prefer fewer, larger issues), `filed issues start in` (Research by default; Implementation for small fully-specified items; Backlog to gate each by hand).
  6. **Standing decisions** — rulings the human has made that runs must not relitigate. Grows over time; a Dropped direction's reason usually belongs here.

**Where the charter lives.** Its intended home is a `charter` prompt context item scoped to the workstream's label, so it reaches every issue carrying the label through the normal effective-context merge. Label-scoped context is Tines/168; until it lands, the charter is the **description of a standing issue in the `Workstream` workflow** (see Interim below), and PM issues name it with a `Workstream: <project>/<number>` line.

Shared PM rules — the PRD template, filing conventions, cross-workstream dedupe — live in the state instruction prompts, as they do for every other workflow.

### Boundaries between PMs

Three mechanisms, in order of strength:

1. **The charter's owns / does-not-own lists** with the hand-off rule. A PM that finds a neighbour's concept files it under the neighbour's label and stops.
2. **Global dedupe at discovery time.** Every discovery run lists all Product Direction issues across all workstreams and all states before pitching, and reads Dropped reasons as rejections.
3. **The human at the Proposed gate.** Overlap that survives 1 and 2 is resolved by dropping one pitch with a reason, which feeds back into 2 and, when durable, into the charter's standing decisions.

### Product Discovery (the scheduled run)

One schedule per workstream; each run issue carries the label and the `Workstream:` line via the schedule's templates.

| State | Category | Meaning |
| --- | --- | --- |
| Backlog (initial) | backlog | Only for hand-created runs; schedules create instances directly in Discovering, since backlog states are never dispatched. |
| Discovering | active | The PM reads the charter, the record (all directions, prior discovery reports, the labelled engineering backlog), and the product as the target user; files 1–3 pitches. |
| Proposed | done | Pitches filed. |
| Nothing to propose | done | Nothing worth filing; the report says what was considered. |
| Abandoned | done | Could not report. |

Transitions: *Start discovery*; *Directions proposed* and *Nothing to propose* both require a fresh `discovery-report` (text/markdown: journey walked, gaps with evidence, pitches filed, candidates not filed with reasons, pipeline count, suggested focus); *Cancel*; *Abandon run*.

A **pitch** is a Product Direction issue created in Proposed with the workstream label and a description of: `Workstream:` and `Source: discovery <ref>` lines, then *User and moment*, *Problem* with evidence, *Concept* in a paragraph, *Why now*, *Size* (`feature` or `direction`), *Touches*. It is deliberately not a PRD: PRDs cost a run each and are written only for pitches a human picks. If the workstream already has `max in flight` directions in progress the run files at most one pitch.

### Product Direction (one issue per concept)

| State | Category | Who acts | Leaves via |
| --- | --- | --- | --- |
| Proposed (initial) | backlog | human | *Draft PRD* → Drafting; *Drop* |
| Drafting | active | PM | *Submit for review* (requires fresh `prd`) → PRD Review; *Drop* |
| PRD Review | awaiting_human | human | *Approve* → Planning; *Rework* → Drafting; *Drop* |
| Planning | active | PM | *Tranche filed* (requires fresh `delivery-plan`) → Delivering; *Drop* |
| Delivering | active, blocked | PM, once unblocked | *Shipped* (requires `ship-report`); *Plan next tranche* → Planning; *Needs decision* → PRD Review; *Send back to drafting*; *Drop* |
| Shipped | done | | |
| Dropped | done | | *Reopen* → Proposed |

**The alignment loop** is Drafting ⇄ PRD Review. The human comments and takes *Rework*; the `prd` artifact goes stale, so the PM must attach a revised version (or explicitly reaffirm) before it can resubmit — the same freshness rule Engineering uses for design docs. Each version stays in the artifact's history. The human may also attach a `prd` version themselves and *Approve*.

**The PRD** has a fixed template: *User and problem* (with evidence) · *Proposal* · *Journeys* before/after, including the agent-facing side where relevant · *In scope / Out of scope* (out of scope names the neighbours it stays clear of) · *Success signals* (observable behaviours a Delivering run can verify) · *Risks and open questions*, each with a default · *Delivery plan*: the engineering issues to file, as few as the work allows — one issue owns a user-visible outcome end to end and may carry up to roughly 2,000 lines of hand-written change; split only on a real seam, never by layer — with title, scope, acceptance criteria, dependencies, grouped into tranches only when the plan exceeds the charter's tranche size · *Non-goals*. **Approving the PRD approves the delivery plan**; amendments in the approval comment beat the artifact, so Planning files rather than invents.

**Planning** files the next tranche as Engineering issues — label, `Source: direction <ref>` first line, `Workstream:` line, PRD pointer, scope and acceptance criteria — in the charter's start state, links dependent items to each other, and links **each one as a blocker of the direction** (`tines issues block <new> <direction>`). It attaches a fresh `delivery-plan` (tranche filed, what remains, what shipped or was cancelled, amendments applied) and transitions *Tranche filed*.

**Delivering** is the mechanism that makes this work without polling: an issue in an `active` state is not eligible for dispatch while any blocker is effectively open, and becomes eligible the moment the last one reaches a done state (Closed *or* Canceled). Because Planning links the blockers *before* transitioning, arrival in Delivering never dispatches. When it does dispatch, the PM reads each blocker's outcome (`impl-pr`, `review-notes`, cancel reasons), checks the PRD's success signals against the product at `main`, and takes exactly one transition: *Shipped* with a `ship-report`; *Plan next tranche* when plan items remain and nothing diverged; *Needs decision* when a blocker was cancelled, what shipped diverged, or a signal fails and the fix is not in the plan — with the decision and a default in the comment, answered by *Approve* (back to Planning) or *Drop*. A Delivering run dispatched with no blockers ever filed takes *Plan next tranche*.

Planning and Delivering alternate so that no PM run ends without a transition. The human can intervene at any point — *Drop*, *Send back to drafting*, or a comment that the next run reads.

### Routing and capacity

State-scoped rules send the four active PM states (Discovering, Drafting, Planning, Delivering) to the `smartest` tier, matching the other reasoning-heavy stages. The per-state roster quota bounds concurrent PM runs. Human throughput is bounded by design at two gates: Proposed (a paragraph to read) and PRD Review (a document). Discovery cadence is per schedule; the initial set runs every two days, half the workstreams on odd days and half on even, three hours apart, so at most three discovery runs start on any day.

### Interaction with Backlog Triage

Pitches and charters sit in `backlog`-category states, which the Backlog Triage run would otherwise judge for relevance. Its Triaging prompt now excludes Workstream charters and Product Direction pitches: the human triages pitches by hand at the Proposed gate, and a pitch waiting is a decision not yet made, not staleness.

## Interim: charters as Workstream issues

Until Tines/168 lands, the charter is the description of one issue per workstream in the **`Workstream`** workflow:

| State | Category | Meaning |
| --- | --- | --- |
| Defined (initial) | backlog | The charter. Never dispatched; skipped by triage. Its thread is where boundary changes are discussed. |
| Retired | done | The area is no longer pursued; *Reinstate* brings it back. |

Humans edit the description directly; agents never do — they propose changes as comments. Every PM issue carries `Workstream: <project>/<number>` and the stage prompts start with `tines issues show <charter ref>`. Tines/182 records the migration: create the `charter` item per label from the issue text, repoint the five prompts and the schedules' templates, and decide whether Workstream issues stay as discussion threads or retire.

## Initial workstreams

Created 2026-09-05 from the drafts in `charters/` (the issue descriptions are the live copies; the files are the design record):

| Label | Charter issue | Discovery schedule (Europe/Dublin) |
| --- | --- | --- |
| `onboarding` | Tines/183 | odd days 10:00 |
| `operator` | Tines/184 | even days 10:00 |
| `projects` | Tines/185 | odd days 13:00 |
| `team` | Tines/186 | even days 13:00 |
| `performance` | Tines/187 | odd days 16:00 |
| `collab` | Tines/188 | even days 16:00 |

Collaboration runs at tighter limits (1 in flight, 1 pitch per run, tranches of 2) because Tines is single-tenant today and its directions shape architecture first.

## Setting up a workstream

Once its charter is agreed:

```sh
tines labels create <label> -d "<one line: the target user>"
tines issues create Tines -w Workstream -l <label> -t "Workstream: <Name>" -d @charter.md
#   → note the ref, e.g. Tines/190
tines issues create Tines -w "Product Discovery" -l <label> \
  -t "Discovery: <Name>" -d "Workstream: Tines/190" \
  -s Discovering --cron "0 10 */2 * *" --tz Europe/Dublin --if-closed \
  --schedule-name "discovery-<label>"
```

Run keys cannot create labels, so the label is made by a human here; PMs only apply it. Creating the schedule files its first discovery issue immediately. After creating the charters, add a "Neighbour charters" line with the other issues' refs to each one's *Does not own* section.

## Acceptance criteria

1. A discovery run for a workstream files pitches that carry its label and `Workstream:` line, cites evidence from the product, and lists in its report every candidate it did not file.
2. A pitch picked with *Draft PRD* yields a `prd` artifact in the template; *Rework* with a comment yields a new version that addresses the comment; *Approve* moves it to Planning without further human action.
3. Planning files at most `tranche size` Engineering issues, each labelled, sourced, and linked as a blocker; the direction sits in Delivering and is not dispatched while any blocker is open.
4. When the last blocker closes, a Delivering run starts within one sweep and ends in exactly one of *Shipped*, *Plan next tranche*, or *Needs decision*, never in a comment alone.
5. A concept belonging to a neighbouring workstream is filed under the neighbour's label, not pursued.
6. The Backlog Triage run never cancels a Workstream charter or a Proposed pitch.

## Resolved questions

- **Discovery is separate from drafting.** A run that wrote a full PRD per idea would spend a run per idea before a human had said yes; pitches are cheap to write and cheap to triage, and the human's picks and drops become the strongest signal later runs read.
- **Delivering is `active`, not `awaiting_human`.** The readiness rule does the waiting; the PM, not the human, judges what shipped. The human keeps *Drop* and *Send back to drafting* at every step.
- **Planning and Delivering are two states.** Filing a tranche and judging its outcome are different jobs, and each must end in a transition; a single state would need a self-transition, which workflows reject, or a run that ends without one, which strikes.
- **Filed issues start in Research by default.** PRD approval is the human's go; the label and quotas remain the throttle. The charter can say Backlog to gate each issue by hand.
- **The charter reaches implementers.** Once label-scoped, a charter applies to the engineering issues too, so implementers see the product intent; narrow it to `label ∧ state` if it becomes noise.
- **Fewer, larger issues.** The first day's PRDs planned eight or nine "small" issues per feature and split one by layer (shared types, endpoint, CLI). An Engineering issue here routinely carries ~2,000 lines of hand-written change through Research, Design and Implementation on its own, so the Drafting and Planning prompts now plan at that scale: a feature is usually one or two issues, a split needs a real seam, and Planning merges plan items that would be reviewed together even when the PRD listed them apart.
- **PMs close directions.** The `ship-report` is the record; a human can reopen via the thread. A Ship Review gate can be added later if PM judgement proves unreliable.
