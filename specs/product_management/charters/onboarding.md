# Workstream: Onboarding

## Target user and moment

Someone who has just found Tines and has one goal of their own they want an agent to work on. The primary persona is a **developer with a repository**: they have used a coding agent by hand, want work to happen while they are not watching, and will judge Tines in the first hour by whether an agent did something real on their code and came back to them. The secondary persona is a **person with a goal and no repository** — organising a family, planning a trip (the Paris 2026 project is the live example) — who needs the same first hour to end with an agent having done a real piece of their goal.

The moment runs from the landing page to the **first completed handoff loop**: sign in, a project, a runner, one issue, an agent run, and the human's first review-and-send-back or approve. Whatever happens after that first loop is not onboarding.

## Owns

Landing and sign-in; the first project and first issue; the first runner (the local daemon's first start, or the first managed key); empty states everywhere a new user meets one; starter workflows and templates for both personas, including non-code ones; `tines login` and the CLI's first-run guidance; the README's Getting started and any first-hour docs; the moment automation is first armed.

## Does not own

- **Operator** — everything from the second loop on: the daily inbox, run legibility, the issue page in steady use.
- **Team building** — hiring as a repeatable concept: role templates, workflow packages, sharing. Onboarding may pitch that the first run *uses* a starter, not how starters are built or shared.
- **Team performance** — the second runner, budgets, quotas.
- **Projects** — anything that only matters once a user has two projects.

Neighbour charters: Operator Tines/184 · Projects Tines/185 · Team building Tines/186 · Team performance Tines/187 · Collaboration Tines/188.

Hand-off rule: a concept that belongs to a neighbour is filed as a Proposed pitch with the neighbour's label and `Workstream:` line, and not pursued here.

## Evidence sources

Walk the first hour end to end in the running app at desktop and mobile: landing → magic-link sign-in → first project → new issue → Agents tab → arm automation, with an empty local D1 so every empty state shows. Read `README.md` (Getting started, Running agents), `docs/runner-daemon.md`, and the landing page copy. Read the Paris 2026 project's workflows (Scout, Idea, Publish) and its `conventions` context item as the non-developer baseline. Read the latest `design-report` and `docs-report` artifacts for findings on first-run surfaces, and the `qa` and `design` labelled engineering issues touching them.

## Limits

- max in flight: 2
- pitches per run: 2
- tranche size: 3
- filed issues start in: Research (Implementation for small, fully-specified items)

## Standing decisions

- The first-run path is designed for the developer and must not *require* a repository; the no-repo persona is supported, not primary.
- Family organisation and trip planning are valid first goals; starter templates for them are in scope.
- Automation stays off for a new user until they arm it (supervisor spec); onboarding may make arming obvious, not automatic.
