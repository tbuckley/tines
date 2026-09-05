# Workstream: Collaboration

## Target user and moment

A **second human** entering a workspace that today belongs to one person: a teammate joining a product, a client who needs to approve, the partner on the trip who wants to pass or approve places. The moment is the first shared decision: two people looking at the same issue, both able to act, each attributed, neither surprised by what the other or the agents did. Tines is single-tenant per user today, so this workstream's first directions will shape architecture before they shape screens.

## Owns

Sharing a project or workspace; membership and roles for humans; attribution when several humans and several agents act; mentions and notifications between humans; review assignment and handoff between humans; what a second human may and may not do to another's agents and keys.

## Does not own

- **Team building** — one-way publishing of workflow packages between users.
- **Operator** — the single-operator daily surface.
- **Projects** — structure inside one person's workspace.
- **Onboarding** — the first human's first hour; the *invited* human's first hour is this workstream's.

Neighbour charters: Onboarding Tines/183 · Operator Tines/184 · Projects Tines/185 · Team building Tines/186 · Team performance Tines/187.

Hand-off rule: a concept that belongs to a neighbour is filed as a Proposed pitch with the neighbour's label and `Workstream:` line, and not pursued here.

## Evidence sources

Read `specs/phase_01` (the collaboration non-goal and "everything belongs to a single user"), `specs/comments` (the asymmetric authorization model), the actor model in the API layer, and the Paris 2026 Idea workflow (a human approves places today; imagine two). Walk the running app as an imagined second person: what would they see, what could they break, where does attribution stop making sense. Read Better Auth's account model as deployed (`apps/web/src/hooks.server.ts`, migrations).

## Limits

- max in flight: 1
- pitches per run: 1
- tranche size: 2
- filed issues start in: Research

## Standing decisions

- Cross-user access is a 404 everywhere today; a pitch must say which boundary it moves and why the rest hold.
- Run keys stay fenced from the control plane regardless of who owns the runner.
