# Workstream: Operator

## Target user and moment

The **solo operator** who already has agents working and drives them every day — and the **agent** on the other side of each handoff. The human's moment is the daily pass: open Tines, see what needs them, review what came back, send it on, and understand what the agents are doing and costing without reading logs. The agent's moment is a run: it is handed a launch prompt and a CLI and must understand the issue, do the work, leave the record, and take the right transition without a human in the loop.

The two views are one workstream because every handoff has both sides, and a change to one is felt on the other: what the agent writes is what the human reads, and how the human steers is what the next run is told.

## Owns

Human view: the Issues tab and its filters, the issue page (state, comments, artifacts, relations, activity), the review inbox as a concept, the Activity feed, run rows and run logs, mobile layouts, notifications of any kind. Agent view: the launch prompt's shape and content, the `tines` CLI as an agent's tool (ergonomics, `--json`, error messages that let an agent recover), artifacts and their gates, comments as the handoff medium, journals and the self-improvement loop (journal upkeep, distillation, context change proposals) as the agent experiences them.

## Does not own

- **Onboarding** — anything before the first completed handoff loop.
- **Projects** — surfaces or filters that only matter with two or more projects, even on pages this workstream owns.
- **Team building** — authoring workflows, prompts, roles, and packages; the operator uses them, the builder makes them.
- **Team performance** — runners, budgets, quotas, cost and throughput analytics; the operator may see a cost on a run row, but the fleet's dashboard is not theirs.
- **Collaboration** — a second human.

Neighbour charters: Onboarding Tines/183 · Projects Tines/185 · Team building Tines/186 · Team performance Tines/187 · Collaboration Tines/188.

Hand-off rule: a concept that belongs to a neighbour is filed as a Proposed pitch with the neighbour's label and `Workstream:` line, and not pursued here.

## Evidence sources

Walk a day in the running app with the seeded data: Issues tab → an awaiting-human issue → read the thread and artifacts → send back with a comment → Activity feed → a run's log, at desktop and mobile. Read `tines issues prompt <ref>` for a real Engineering issue and judge it as the agent would. Read the `agent-guidelines` global prompt, the Engineering stage prompts, and the project's stage journals (`tines context list -k prompt -p Tines`) — journal entries are the agents' own record of where the tools fought them. Read the latest `qa-report`, `design-report`, and `review-notes` artifacts, and the `tooling`, `design`, and `qa` labelled engineering issues. Read `specs/phase_01`, `specs/comments`, `specs/artifacts`, and `specs/context/AGENT_EDITING.md`.

## Limits

- max in flight: 2
- pitches per run: 2
- tranche size: 3
- issue size: up to ~2k lines of hand-written change per issue; prefer fewer, larger issues
- filed issues start in: Research (Implementation for small, fully-specified items)

## Standing decisions

- Steering happens through comments and transitions, never mid-run chat (supervisor user flow 6).
- Comments are for prose, artifacts for records, journals for reusable lessons (agent-guidelines); pitches that blur these need a reason.
- Motion communicates change and never decorates; all motion respects reduced-motion (phase-one look and feel).
