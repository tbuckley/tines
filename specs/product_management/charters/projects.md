# Workstream: Projects

## Target user and moment

An operator whose workspace holds **several unrelated projects** — a product, a side project, a trip — that share one workflow library, one context library, one label vocabulary, one set of runners, and one activity feed. Today that is Tines and Paris 2026 in the same workspace. The moment is switching: coming back to the workspace and finding the right project's work, keeping one project's conventions from leaking into another, and seeing across all of them when that is what they want.

## Owns

Project structure: hierarchy and nesting, archiving, moving issues between projects; cross-project navigation and the project filter on every list; what is shared across projects versus scoped to one (the library's shape, the label taxonomy, per-project routing and quotas as *structure*); the Projects tab and project pages; project-level context and defaults.

## Does not own

- **Operator** — any surface as it works at one-project scale.
- **Team building** — what a workflow package *is* and how it moves between projects or users; this workstream owns where a package lands and how it is scoped once it has.
- **Team performance** — per-project cost is a performance concern; per-project routing as a structural boundary ("acme never leaves the laptop") is this workstream's.
- **Collaboration** — sharing a project with another human.

Neighbour charters: Onboarding Tines/183 · Operator Tines/184 · Team building Tines/186 · Team performance Tines/187 · Collaboration Tines/188.

Hand-off rule: a concept that belongs to a neighbour is filed as a Proposed pitch with the neighbour's label and `Workstream:` line, and not pursued here.

## Evidence sources

Walk the workspace with both projects populated: Projects tab → each project page → Issues tab with and without the project filter → Context tab → Workflows tab → Agents tab routing rules → Settings → Labels, at desktop and mobile; note every place two projects collide or one is hidden. Read `specs/phase_01` (the "trees come later" non-goal), `specs/context/SPEC.md` (scope dimensions and layer order), the supervisor spec's routing section, and the labels migration's project-scoping note (`apps/web/migrations/0018_issue_labels.sql`). Read the `design-report` and `docs-report` artifacts for cross-project findings.

## Limits

- max in flight: 2
- pitches per run: 2
- tranche size: 3
- issue size: up to ~2k lines of hand-written change per issue; prefer fewer, larger issues
- filed issues start in: Research

## Standing decisions

- Project names address projects in URLs and CLI refs and stay unique per user.
- Labels are workspace-wide by design; a per-project scoping is a later addition, not a replacement.
- The schema must never assume projects are leaf-only (phase-one spec).
