# Workstream: Team performance

## Target user and moment

An operator running a **team of agents that costs real money** and wants to know whether it is working and what to change. The moment is the weekly question: where is work waiting, which stage is the bottleneck, which runner or role is stalling, what did each outcome cost — and, having changed something (a prompt, a tier, a new member, a quota), did it help. Today the raw facts exist (runs, outcomes, usage, events) and the judgement is done by reading them.

## Owns

Bottleneck detection: where issues wait and why (queue, quota, awaiting human, parked); roster scaling — quotas, per-state concurrency, adding runners or managed capacity when a stage backs up; budgets, tiers, pricing, and cost per outcome; **experiments** — trying a change to the team (a prompt version, a model tier, a new role) and comparing before and after; **tracking over time** — outcome rates, cost, cycle time per stage, so improvement and regression are visible; the Agents tab as a fleet dashboard; the dispatch explainer.

## Does not own

- **Team building** — what a role or package is; this workstream says which one is needed next and whether the last one helped.
- **Operator** — a single run's legibility; this workstream owns the aggregate.
- **Onboarding** — the first runner.
- **Projects** — per-project routing as a structural boundary; this workstream owns per-project cost and throughput.

Hand-off rule: a concept that belongs to a neighbour is filed as a Proposed pitch with the neighbour's label and `Workstream:` line, and not pursued here.

## Evidence sources

Read the supervisor spec's usage, budgets, quotas, and "Future work" sections (outcome-rate analytics, ledger retention, ping-pong detection are named deferrals) and user flows 5, 12, 13, and 19. Walk the Agents tab (runners, routing, quota, budgets) and `tines supervisor status`, `tines runs list --json`, `tines issues dispatch <ref>` against the live workspace; compute by hand what a dashboard would show (issues per state, time in state, runs per outcome, cost per merged PR) and note what could not be computed. Read the `journal` prompts for stage-level friction and the `Merging` / `Automated Review` journals for retry patterns. Read the `arch` labelled issues touching the supervisor.

## Limits

- max in flight: 2
- pitches per run: 2
- tranche size: 3
- filed issues start in: Research

## Standing decisions

- Daily budgets are stored but not yet enforced (README); a pitch relying on them must say so.
- The strike system parks issues; agent-to-agent ping-pong is bounded only by quotas and budgets (supervisor spec) — a detection pitch must not turn the strike system into enforcement by accident.
- Success signals are observable in the tracker's own data; no external analytics service.
