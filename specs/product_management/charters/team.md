# Workstream: Team building

## Target user and moment

An operator who has **one agent doing one kind of work** and wants more done: the next role, the next workflow, the conventions that make them good. The arc runs from hiring the first agent, to a team that can carry a feature from idea to merged MVP, to an organisation of roles — auditors, ideation, PMs, release — that improves itself. The moment is composition: deciding what the team should do next, expressing that as workflows, prompts, and schedules, and reusing what already works instead of writing it again.

## Owns

Hiring as a repeatable concept: what a role is (a workflow plus its state prompts, schedule, and routing) and how a user adds one; role and workflow templates; **workflow packages** — sharing a working workflow with its prompts, requirements, and schedules between projects and between users (the Export/Import surface and what it should become); **context reuse across related states** — several states today need the same knowledge (merging a PR in Engineering and Docs Change; walking the app in QA and Design Audit) and each carries its own copy; the workflow editor and context authoring as the builder's tools; recommending the **next role** a team would benefit from, given what it has.

## Does not own

- **Onboarding** — the newcomer's *first* agent; this workstream owns hiring from the second role on and the machinery the first one uses.
- **Team performance** — measuring the team: bottlenecks, experiments, cost, roster scaling. When a next-role recommendation needs throughput data, performance owns the data and this workstream owns what the recommendation offers to add.
- **Operator** — how the agent experiences a run; this workstream owns what it is *told*, operator owns the tools it is given.
- **Projects** — where a package lands and how it is scoped.
- **Collaboration** — sharing between users beyond one-way publishing of packages; anything requiring a shared workspace.

Hand-off rule: a concept that belongs to a neighbour is filed as a Proposed pitch with the neighbour's label and `Workstream:` line, and not pursued here.

## Evidence sources

Read the whole workflow library (`tines workflows list`, `show` each) and every state's `instructions` prompt; catalogue the duplicated knowledge across states and the conventions each prompt has to re-teach. Walk Workflows → New, the workflow editor, the Context tab, and Settings → Export/Import in the running app. Read `specs/context/SPEC.md` and `AGENT_EDITING.md` (layer order, journals, proposals), `specs/artifacts` (requirements), `specs/scheduled_tasks`, and the Distillation workflow's reports (`distill-report` artifacts) — distillation is the existing "promote a lesson into shared context" path. Read the `tooling` labelled engineering issues and the `Context change:` issues agents have filed.

## Limits

- max in flight: 2
- pitches per run: 2
- tranche size: 3
- filed issues start in: Research

## Standing decisions

- Agents never edit shared context directly; changes route through review (AGENT_EDITING). A pitch that automates promotion must keep a human gate.
- Stage instructions live in state-scoped prompts; Tines injects no directive text of its own (context spec).
- A role is expressed with existing primitives — workflow, prompts, schedule, routing — before any new entity is proposed.
