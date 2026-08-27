# Supervisor — Implementation Plan

The delivery plan for [SPEC.md](./SPEC.md) as revised by [USER_FLOWS.md](./USER_FLOWS.md). Work is grouped into four **milestones**, each merging as one PR that brings new, useful functionality to the app. Within a milestone, work proceeds in the internal phase order listed, so the commit history keeps natural review checkpoints even though each milestone lands whole.

## Decisions shaping the ordering

Recorded from the planning discussion:

- **Local runner first.** The local daemon reaches end-to-end before any managed runner: no provider API dependency, no credential encryption needed, matches acceptance criterion 1, and the e2e suite's custom-script harness makes it deterministically testable.
- **Claude managed before Gemini.** Provider-reported cost (`list_cost`) and the platform-enforced per-run budget make the money layer honest sooner, and no single-file CLI build is needed (npm-install bootstrap). Gemini's environment seeding, proxy transforms, and 1 MB single-file CLI build come last.
- **Money layer split.** The usage ledger and per-run caps (the $5 default via session `budget.max_list_cost`) ship in the same milestone as the Claude runner — real dollars are bounded from day one — while daily budgets, the pricing table, meters, and unpriced warnings follow as their own milestone.
- **UI interleaved.** Each milestone ships its own UI surfaces, so every milestone is usable end-to-end from the browser, matching the user flows. No CLI-only interim states.
- **Milestone PRs, not phase PRs.** Phase-sized PRs were considered and rejected: the phase cuts were review-sized, not value-sized — nothing before a working runner is useful on its own. Each milestone is the smallest mergeable unit that delivers something the user would actually use the next day. Everything stays inert behind the kill switch (default off, per flow 1), so partially built supervisor code on `main` is safe between milestones.

## What exists to build on

Phase 1, scheduled tasks, context attachments, and issue dependencies are all implemented. The supervisor slots into established seams:

- The custom worker entry (`apps/web/worker/index.ts`) already has a `scheduled()` handler and the `--test-scheduled` e2e hook; the supervisor sweep joins it (cron tightened `*/30` → `*/5`; the schedules sweep is `next_run_at`-gated, so the faster cadence is harmless).
- The context system provides the scope model to reuse for routing rules, and the `/prompt` + `/context` endpoints supply launch materials.
- `issue_link` provides readiness (`ready=true`) for eligibility.
- The actor model (`actor_api_key_id` on comments/events) is exactly what run-key attribution and end judgment need.
- The CLI (`packages/cli`) is ready to grow `runners` / `runs` / `routing` commands and the daemon.

---

## Milestone 1 — Your laptop works the backlog

The smallest unit that delivers the product's core promise — flows 1 and 2 end to end: register `laptop-m4` with one terminal command, create a routing rule, flip the kill switch, drag an issue to `Open`, and watch an attributed run narrate in the thread and hand off to review.

This is by far the biggest milestone — roughly half the total work — but every cut below it leaves something that does nothing.

### Internal phase order

**Phase 0 — Fold the spec deltas into SPEC.md.** USER_FLOWS.md records 11 deliberate deltas (routing specificity `project > state`, settings-write dispatch triggers, queue position in the explainer, rotate-token in v1, retroactive repricing, kill-switch bulk cancel, flagged-not-deleted empty rules, `cancels` = kill-without-finish, comment-on-interrupt, escalation banner, `enabled` off by default). Revise SPEC.md first so implementation targets one document instead of two with precedence rules.

**Phase 1 — Schema, settings, routing, and the run-key model.**

- Migration 0009: `runner`, `agent_run`, `routing_rule`, `supervisor_settings` tables; `issue` gains `pinned_runner_id`, `pinned_tier`, `attempt_count`, `needs_attention`; `api_key` gains `agent_run_id`, `expires_at`. Indexes per spec: `(issue_id, created_at)`, a partial index on active run statuses for quota counts, `(user_id, created_at)` for the future budget tally.
- Shared types in `@tines/shared` for all of it.
- Supervisor settings API/CLI: kill switch (default off), quota policy JSON, attempt limit.
- Routing rules API/CLI + pins on `PATCH /issues/:id`: one rule per exact scope, target validation, `project ∧ state > project > state > global` specificity, shadow-hint warnings at authoring time.
- Run-key auth semantics in `auth.ts`/`core.ts`: expiry checking, revocation, and the control-plane 403 fence (runners, routing rules, settings, resume, key management) with the proposal-convention message. Attribution rendering "via *runner* · run …" in threads and the feed.
- UI: Agents tab skeleton — routing section with scope chips, automation settings card, inline routing rows on project/state pages.

**Phase 2 — Dispatch engine against a fake adapter.**

- Adapter interface (launch / poll / cancel / credential setup) + a fake adapter for unit tests.
- Dispatch pass: eligibility (category `active` + ready + no active run + not parked + rule/pin match + kill switch), oldest-`updated_at` ordering, rule matching, target walking, and the guarded `INSERT … SELECT` claim carrying no-active-run / eligibility / runner-cap / quota checks in one statement. Both quota policies (`global_cap`, `state_roster` counted by `state_id_at_start`).
- Minimal tier resolution: built-in per-type defaults + `default_tier`; runs record `tier` and resolved `model`. Full overrides come in Milestone 2.
- Triggers: opportunistic `ctx.waitUntil` passes on eligibility-changing events; the `*/5` supervisor sweep alongside the schedules sweep.
- End judgment (transition authored by the run's key), strikes, parking, resume (`POST /issues/:id/resume`, `tines issues resume`), launch-failure backoff per runner.
- Dispatch explainer (`GET /issues/:id/dispatch` + `tines issues dispatch`) including queue position.
- UI: issue-page Agent activity panel (verdict line + expandable explainer), parked banner + amber board marker, kill-switch off-state banner.
- The heavy unit-test phase: claim races, quota counting, strike/park/resume, explainer verdicts — all against the fake adapter.

**Phase 3 — Local runner end-to-end.**

- Runner protocol: `register` / `poll` / `logs` / `finish`; hashed runner tokens confined to protocol endpoints; one-shot assignment delivery as the guarded `assigned → launching` flip; `owned_runs` reconciliation; `cancels` = kill-without-finish.
- Daemon (`tines runner daemon`): registration + token persistence, polling, workspace materialization (the existing `--out` bundle layout), the three harnesses (`claude_code`, `codex`, `custom`), log streaming, state file + orphan kill on restart, graceful Ctrl-C, timeout/cancel/cap kill.
- Supervisor side: run-key minting/delivery/revocation, supervisor preamble generated at poll-delivery time, liveness (2-minute online / 5-minute offline sweep failing runs), timeout enforcement, cancel API/CLI.
- Runner lifecycle: pause/resume (with assigned-run cancellation), reject-by-default delete + force cascade (emptied rules flagged, not deleted), rotate-token, kill-switch bulk-cancel confirmation.
- UI: runner cards (online/paused/offline distinct), local add-runner wizard with the bootstrap command, runs list + log-tail viewer with staleness hints, cancel-with-comment dialog, board run indicator, comment-on-transition prompt (flow 6).
- e2e: real daemon with a script harness + `--test-scheduled` sweeps.

### Milestone 1 covers

Flows 1, 2, 4, 5, 6, 8, 9, 10, 11, 13, 17, 18. Acceptance criteria 1, 2, 4–9, and the local parts of 13.

One consequence worth naming: daily budgets do not exist while the laptop is already running agents. That is fine — local runs spend the existing Claude Code plan, and `max_run_minutes` bounds each attempt. Real metered dollars first appear in Milestone 2, arriving with their per-run cap in the same PR.

---

## Milestone 2 — Cloud capacity, spend bounded per run

New functionality: paste an Anthropic key, get a managed runner that clones repos and works issues while the laptop lid is closed — with every run hard-capped at $5 by default.

- Secret infrastructure: AES-GCM encryption under a Workers secret binding; provider API key storage (write-only, ping-validated); the GitHub PAT in supervisor settings with the inline add-PAT wizard step and blast-radius copy.
- Claude adapter: sessions against lazily provisioned per-tier managed agents (with model-drift re-provisioning), run-id tagging in session metadata, vault credentials (standing `GITHUB_TOKEN` at setup; per-run `TINES_API_KEY` created/deleted with the run, sweep-GC'd), preamble bootstrap (self-clone + `npm i -g tines`, curl fallback noted), sweep polling of session events → log tail + status + usage, cancel, launch reconciliation (fail session-less `launching` runs after 5 minutes; cancel orphaned tagged sessions).
- Money, the bounded half: usage on `agent_run` (`cost_source: provider`), `max_run_cost_usd` defaulting to $5 mapped to session `budget.max_list_cost`, `max_run_tokens`, cost shown on run rows.
- Tier overrides in full: `tines runners tiers`, tier editor UI, stale-override marker, custom-harness "tiers don't apply" state.
- UI: managed add-runner wizard (key ping, editable $5 cap, skippable add-to-routing step), provider console links, rotate-credential surfaces (flow 16).

Covers flows 3, 14, 16; acceptance 3 (Claude half) and 10.

**Risk flag:** this milestone depends on the current shape of the Anthropic Managed Agents + vault APIs — re-verify against live docs at the start of the milestone. The adapter interface from Milestone 1 isolates any surprises.

---

## Milestone 3 — The money picture

New functionality: "never more than $10/day total, and this runner no more than $3" — plus the weekly what-did-it-cost audit.

- Global and per-runner daily USD/token budgets with timezone windows (accrual at observation time) and the dispatch gate (advisory, outside the claim guard).
- Budget edits join the opportunistic dispatch triggers, so a raised ceiling un-sticks dispatch in seconds.
- Pricing table in code + user overrides + retroactive repricing of the current window.
- Unpriced fail-open-loudly treatment: warning banner, runner/run badges, `runner.unpriced_usage` event throttled once per runner + model per day; unpriced vs unreported visually distinct.
- `GET /api/v1/usage` + `tines usage` (windows, `--by runner|tier`, headroom) + live spend meters on settings and runner cards.
- Utilization surfaces: `tines supervisor status` and the Runs section header ("3/3 global slots", "Open 3/3 · Review 0/2").

Covers flows 12, 15, 19; acceptance 11.

---

## Milestone 4 — Second provider and operational hardening

New functionality: Gemini as a cheap-tier fallback route, and the fleet surviving a provider's bad day legibly.

- Single-file CLI build: `tines.cjs`, zero dependencies, CI-guarded under Gemini's 1 MB inline-source cap; the no-key/proxy-auth behavior and `TINES_CONFIG` file support. (A `packages/cli` change useful on its own.)
- Gemini adapter: background interactions, environment seeding (effective repos as `sources`, skills inline, the CLI + proxy-auth config), egress-proxy `transform` injection of the PAT and run key, per-interaction model + `max_total_tokens`, steps polling → log tail, cancel, AI Studio `provider_url`.
- Hardening: escalated launch-failure banner (~10 consecutive failures), outage-vs-bad-credential-vs-bogus-model error copy on runner cards (flow 20), launchd/systemd service snippets in the daemon docs, motion polish on run rows per the house rules.
- A full pass over all 13 acceptance criteria and the 20 user flows, with any spec-vs-implementation drift written back into SPEC.md.

Covers flow 20 and the Gemini halves of flows 3/12; acceptance 3, 12, and the remainder of 13.

---

## Why this ordering holds together

Each milestone is independently mergeable and immediately useful: Milestone 1 delivers the entire flow-1/flow-2 experience on a laptop with zero provider risk; Milestone 2 adds cloud capacity with spend hard-capped at $5/run before daily budgets exist; the two heaviest provider integrations (Milestones 2 and 4) are separated by the money layer they both feed. The riskiest external dependencies — provider API shapes — sit behind an adapter interface that Milestone 1 will have already proven against the fake and local adapters.
