# Supervisor — Implementation Plan

The delivery plan for [SPEC.md](./SPEC.md) as revised by [USER_FLOWS.md](./USER_FLOWS.md). Work is grouped into four **milestones**, each merging as one PR that brings new, useful functionality to the app. Within a milestone, work proceeds in the internal phase order listed, so the commit history keeps natural review checkpoints even though each milestone lands whole.

> **Revised after Milestone 2 (September 2026).** Milestones 1 and 2 have shipped. The original order put the money layer third and Gemini last; this revision swaps them — Gemini managed agents are Milestone 3, and the daily-budget layer merges with operational hardening as Milestone 4. The reasoning is under "Decisions shaping the ordering".

## Decisions shaping the ordering

Recorded from the planning discussion:

- **Local runner first.** The local daemon reaches end-to-end before any managed runner: no provider API dependency, no credential encryption needed, matches acceptance criterion 1, and the e2e suite's custom-script harness makes it deterministically testable.
- **Claude managed before Gemini.** Provider-reported cost (`list_cost`) and the platform-enforced per-run budget make the money layer honest sooner, and no single-file CLI build is needed (npm-install bootstrap). Gemini's environment seeding, proxy transforms, and 1 MB single-file CLI build come after.
- **Gemini before the daily-budget layer** (revision, after Milestone 2). Gemini 3.8 Flash shipped on 2 September 2026 as Antigravity's default and the strongest agentic model at its price — the cheap-tier route the routing vocabulary was designed for became worth having *now*, before a second month of Claude-only spend. Two things made the swap cheap: the adapter interface Milestones 1–2 proved against the fake and Claude adapters means Gemini is one adapter plus a wizard path, and the money layer's only Gemini-specific need — dollars for a provider that reports tokens only — is met by pulling a minimal built-in pricing table forward (list rates in code, `cost_source: priced`), leaving daily budgets, user overrides, and the unpriced-model warnings where they were. The per-run dollar cap, which Gemini cannot enforce natively, is enforced at poll time from that table so the $5 default stays real on both providers.
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

## Milestone 3 — Second provider: Gemini managed agents

New functionality: paste a Gemini API key, get a managed runner whose runs are background Antigravity interactions in Google's sandbox — `gemini-3.8-flash` by default, `gemini-3.5-flash-lite` as the `cheapest` route — with the effective repos and skills seeded into each run's environment, the `tines` CLI working inside the sandbox with no key in it, and every run priced from the table.

### Internal phase order

**Phase 1 — The CLI in a file.** `dist/tines.cjs`: the CLI as one dependency-free CommonJS file next to the npm bin, produced by the same build (`packages/cli/scripts/build.mjs`), its version stamped in at build time since there is no manifest beside it, and guarded under Gemini's 1 MB inline-source cap by a unit test that builds and runs it on every pull request. The CLI gains `TINES_CONFIG` (a config file path) and `auth: "proxy"` in that file — "send no Authorization header; the egress proxy adds one" — so a sandbox can run every documented command with no credential inside it. Useful on its own for any environment that can seed a file but not run `npm`.

**Phase 2 — The Gemini adapter.** Spoken over `fetch` against the Interactions API (the `@google/genai` SDK carries Node-only dependencies a worker bundle has no use for): one `POST /v1beta/interactions` per launch with `background: true`, `agent_config: { type: "antigravity", model, max_total_tokens? }`, the run id in `labels`, and a fresh `remote` environment carrying the repos as `repository` sources, every skill file plus the CLI build, a wrapper, and its proxy-auth config as `inline` sources, and a network allowlist whose `transform` entries inject the run key on the Tines host and the PAT on `github.com` (Basic, `x-oauth-basic` — what authenticates the environment's own clone of a private repo and the agent's pushes alike) and `api.github.com`. The bundle is fetched from the npm CDN at launch and cached per isolate — the same "the newest published CLI matches this deployment's prompts" reasoning as the daemon's refresh. Sweeps poll the interaction: new `steps` render to the log tail, `usage` is table-priced (thinking tokens recorded separately, billed at the output rate), and terminal statuses (`completed` / `failed` / `cancelled` / `incomplete` / `budget_exceeded` / `requires_action`) end the run under the ordinary judgment. Cancel is `POST …/cancel`; the sweep deletes ended runs' environments. Built-in tiers: `smartest` and `balanced` → `gemini-3.8-flash`, `cheapest` → `gemini-3.5-flash-lite` (Antigravity runs the Flash family only — there is no Pro tier to point `smartest` at).

**Phase 3 — Surfaces.** The add-runner wizard's Gemini path (key ping against `/v1beta/models`, the managed-agent id defaulting to the current Antigravity preview, the $5 cap with its "checked per sweep" copy, the inlined add-PAT step, the routing nudge); the agent field in the edit view; provider badges on runner cards; the engine's poll-time dollar-cap enforcement; README and CLI README.

### Milestone 3 covers

The Gemini halves of flows 3 and 12, flow 14's Gemini overrides; acceptance 3 (Gemini half), 10, 12, and the Gemini parts of 11 (the $5 default and `max_total_tokens`). Verified against the live API docs at the start of the milestone, as the plan's risk flag asks; the decisions are recorded in SPEC.md under "Resolved questions — from the Gemini milestone".

**Not in this milestone, deliberately:** provider-side orphan cancellation for Gemini (the API lists environments but not interactions, so a crash between interaction create and the DB write leaves an interaction bounded only by its own token budget and the sandbox's idle timeout — recorded in the spec), and the daily-budget gate that turns the pricing table into a ceiling (Milestone 4).

---

## Milestone 4 — The money picture and operational hardening

New functionality: "never more than $10/day total, and this runner no more than $3" — plus the weekly what-did-it-cost audit, and the fleet surviving a provider's bad day legibly.

- Global and per-runner daily USD/token budgets with timezone windows (accrual at observation time) and the dispatch gate (advisory, outside the claim guard).
- Budget edits join the opportunistic dispatch triggers, so a raised ceiling un-sticks dispatch in seconds.
- Pricing: user overrides on top of the built-in table Milestone 3 shipped, retroactive repricing of the current window, and the Claude/local-harness rows the table still lacks.
- Unpriced fail-open-loudly treatment: warning banner, runner/run badges, `runner.unpriced_usage` event throttled once per runner + model per day; unpriced vs unreported visually distinct.
- `GET /api/v1/usage` + `tines usage` (windows, `--by runner|tier`, headroom) + live spend meters on settings and runner cards.
- Utilization surfaces: `tines supervisor status` and the Runs section header ("3/3 global slots", "Open 3/3 · Review 0/2").
- Hardening: escalated launch-failure banner (~10 consecutive failures), outage-vs-bad-credential-vs-bogus-model error copy on runner cards (flow 20), motion polish on run rows per the house rules.
- A full pass over all acceptance criteria and the 20 user flows, with any spec-vs-implementation drift written back into SPEC.md.

Covers flows 12, 15, 19, 20; acceptance 11 and the remainder of 13.

---

## Why this ordering holds together

Each milestone is independently mergeable and immediately useful: Milestone 1 delivers the entire flow-1/flow-2 experience on a laptop with zero provider risk; Milestone 2 adds cloud capacity with spend hard-capped at $5/run before daily budgets exist; Milestone 3 adds the second provider — and the cheap tier — while the same per-run caps still bound every dollar; Milestone 4 then builds the daily ceiling over a ledger that already carries both providers' numbers, so the budget gate is exercised against real, mixed-source spend the day it lands. The riskiest external dependencies — provider API shapes — sit behind an adapter interface that Milestone 1 proved against the fake and local adapters and Milestones 2 and 3 against the live providers.
