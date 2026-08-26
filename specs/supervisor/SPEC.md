# Tines — Supervisor & Agent Execution Spec

Phase one made work legible; the context specs made it launchable. This spec adds the **supervisor**: Tines itself assigns eligible issues to **runners** — Claude Managed Agents (Anthropic API), Gemini Managed Agents (the Interactions API's Antigravity agent), or local devices driving Claude Code / codex — launches them with the assembled launch prompt and workspace, watches them run, and records what happened. The tracker stops being a board agents *visit* and becomes one that *dispatches*.

The architecture is **cloud brain, local hands**: the Cloudflare worker is the single supervisor — it owns eligibility, routing, quotas, claiming, and launching. Managed agents are launched directly over the provider APIs using credentials stored in the runner's configuration. Local devices run a thin **runner daemon** that polls Tines for work assigned to it, materializes the workspace, launches the harness, and streams results back. No inbound connection to a device is ever needed.

## Goals

- A uniform **runner registry**: every executor — managed or local — is a registered row with a type, status, and its own concurrency cap.
- A clear eligibility rule for **which states an agent may take on**, derived from state categories.
- **Scoped routing rules** that decide which runner takes a given issue, reusing the context system's scope model.
- Pluggable, pick-one **quota policies** (global cap and per-state roster ship first) on top of always-on per-runner caps.
- Always-on **daily budgets** — spend (USD) and/or token limits, globally and per runner — backed by a per-run usage ledger and hard per-run caps mapped to provider-native ceilings.
- **Model tiers**: routing speaks `smartest` / `balanced` / `cheapest`; each runner resolves a tier to a concrete model, with built-in defaults per type and per-runner overrides to an exact model/config.
- A **run** record per attempt with status, resolved tier/model, usage, a captured log tail, and a provider session link — visible in the web UI and CLI.
- **Ephemeral per-run API keys** so every agent action is attributable to a specific run and dies with it.
- An attempt budget so a failing issue **parks** instead of burning quota forever.

## Non-goals

- **Multi-user / teams**: everything remains single-user; runners, rules, and runs belong to one user.
- **Roles**: no role entities, no per-state role permissions. The context system's planned role dimension is still future work; eligibility here is category-based only.
- **The curator agent**: `Context change:` proposals (AGENT_EDITING.md) are still reviewed by humans; auto-applying them is later work.
- **Full transcripts**: runs capture a size-capped log tail, not complete transcripts (no R2 in this phase). The provider's own console is the deep-inspection surface.
- **Mid-run steering from Tines**: no chat-with-a-running-agent surface. Cancel is the only mid-run control; steering happens through issue comments the *next* run will read.
- **Exact billing reconciliation**: the usage ledger prices work at list rates — provider-reported where native, else a built-in pricing table — as a control knob, not an invoice. Negotiated discounts, provider minimums, and unreported local usage all make it approximate by design; the provider's own billing page is the source of truth for money actually owed.
- **Fallback across routing rules**: only the winning (most specific) rule's runner list is tried. If it is exhausted, the issue waits — no silent fallback to broader rules.
- **Windows/mobile daemons, harness sandboxing**: the daemon targets macOS/Linux and trusts the harness it launches (Claude Code / codex bring their own permission models).

## Concepts

### Runner

A registered executor, one row per launch target the user owns:

| Type | What it is | Created by |
| --- | --- | --- |
| `claude_managed` | An Anthropic Managed Agents integration: sessions in Anthropic's managed sandbox. | Configuring an Anthropic API key in the web UI. |
| `gemini_managed` | A Gemini Interactions API managed agent (Antigravity): background interactions in Google's sandbox. | Configuring a Gemini API key in the web UI. |
| `local` | A daemon on one of the user's devices driving a local harness — Claude Code (`claude -p`), codex (`codex exec`), or a custom command template. | The daemon self-registering on first connect. |

Every runner has: a **name** (unique per user — routing rules and the CLI address runners by name), a **status** (`active` | `paused`), **`max_concurrent`** (its own cap, always enforced regardless of quota policy; default 1 for local, 3 for managed), a **`default_tier`** and optional per-tier model overrides (see Model tiers), an optional per-runner **budget** (see Budgets), and a type-specific **config**:

- `claude_managed`: Anthropic API key (encrypted at rest, write-only thereafter), the managed agent ids to run sessions against — one per tier, provisioned lazily by Tines on a tier's first use since model/system/tools live on the agent object, not the session; each is stored **with the model id it was provisioned for**, and a launch whose tier now resolves differently (built-in default moved, override edited) updates or re-provisions the agent before use, so tiers never silently freeze. These agent objects are deliberately minimal — default toolset, no directive system prompt; all direction lives in the per-session launch prompt, keeping the context spec's one-place-for-directives rule intact — and the **vault id** holding the GitHub credential (see Credentials).
- `gemini_managed`: Gemini API key (encrypted, write-only), agent name (default the current Antigravity preview id) — the model is passed per interaction in `agent_config`, so tiers need no extra provisioning.
- `local`: the **harness** (`claude_code` | `codex` | `custom` with a command template using `{prompt_file}`, `{workspace}`, and `{model}` placeholders), the device's display info (hostname, platform — reported by the daemon), and a hashed **runner token** used for all daemon calls.

**Local liveness.** The daemon polls (see Protocol) and each poll bumps `last_seen_at`. A local runner is **online** when `last_seen_at` is within 2 minutes; the supervisor never assigns work to an offline runner. A local runner offline for more than 5 minutes has its `running` runs **failed by the sweep** (error `runner offline`, run keys revoked) — a crashed daemon must not hold claims for the full `max_run_minutes`; an orphaned harness process may briefly outlive this, but its key is already dead. Managed runners are always considered online (a failing provider surfaces as launch errors, handled below).

Pausing a runner (status `paused`) stops new assignments immediately **and cancels its not-yet-acknowledged `assigned` runs** (nothing is running yet, so cancellation is free); `launching` and `running` runs finish. The global kill switch behaves the same way across all runners — and because flipping it off is usually a panic action, its confirmation additionally offers **bulk-cancelling the in-flight runs**: plain individual cancels (strikes and all, cost bounded by the per-run caps), no new semantics — the switch plus the option is the full stop.

**Deleting a runner** follows the context spec's reject-by-default posture: `DELETE` is refused while the runner has active runs, or while any routing-rule target or issue pin references it — the 422 names them. `force: true` cascades: referencing targets are stripped from their rules, pins cleared, each with its event. A rule whose target list the cascade empties is **flagged, not deleted** — an amber "no targets" state in the routing list: the scope choice is user intent worth preserving, but the husk must be visible, not a trap the explainer surfaces one issue at a time. No rule or pin ever dangles.

### Model tiers

Routing should say how *hard* to think without naming vendor model ids that go stale. Three generic tiers — **`smartest`**, **`balanced`**, **`cheapest`** — form that vocabulary:

- **Built-in defaults per runner type**, maintained in code and updated as providers ship models (illustrative today: Claude → Opus / Sonnet / Haiku; Gemini → Pro / Flash / Flash-Lite; local `claude_code` → the same Claude trio via `--model`).
- **Per-runner overrides**: a runner's `tiers` map may override any tier with an exact model id and settings (e.g. `{ "smartest": { "model": "claude-opus-5", "effort": "high" } }`) — two runners of the same type can disagree about what "smartest" means. Unlisted tiers fall back to the built-ins.
- **Selection happens where routing happens**: each routing-rule entry (and a pin) names a runner and optionally a tier — `gemini:cheapest` in the CLI. An entry without a tier uses the runner's `default_tier` (itself defaulting to `balanced`).
- **Resolution at launch**: the dispatcher resolves tier → concrete model for the chosen runner and the run records both (`tier`, `model`). Claude runners launch the tier's provisioned managed agent; Gemini runners pass the model in `agent_config`; local `claude_code`/`codex` harnesses receive it via their model flag or the `{model}` placeholder. A runner that cannot vary its model (a custom harness with no `{model}` placeholder) satisfies any tier with its fixed configuration — the run still records the requested tier, with the model marked unknown.

The tier names are a closed set; adding a tier later is a code change, not user config — the point is a stable, small vocabulary that routing rules can rely on.

### What agents may take on

**Category is the whole rule.** An issue is *agent-eligible* exactly when its **effective** state's category is `active` — the category that already means "ready to be taken on, or being worked". `backlog`, `awaiting_human`, and `done` states are never touched by the supervisor, in any workflow, with no per-state configuration. The workflow graph is therefore also the automation boundary: moving work to an `awaiting_human` state *is* how an agent (or human) hands off, and pulling it back to an `active` state is how a human hands it to the agents again.

On top of category, the supervisor dispatches an issue only when **all** of:

- it is **ready** per the dependencies spec (`ready=true`: not effectively done, not a duplicate, no open blockers) — blocked work isn't actionable, and duplicates aren't work;
- it has **no active run** (a run claims its issue exclusively for its duration);
- it is not **parked** (`needs_attention` — see the attempt budget);
- some routing rule matches it (no matching rule = no automation for that issue; automation is opt-in via rules);
- the automation **kill switch** is on (a per-user `enabled` flag in supervisor settings pauses everything at once). It is **off by default** for a new user: creating a runner or a rule signals intent, but budgets aren't configured yet, so arming automation is its own explicit act.

Eligible issues dispatch oldest-`updated_at` first, so long-untouched work gets attention before freshly churning work.

### Routing rules

A routing rule answers "which runner should take this?" and reuses the context system's scope model: nullable `project_id` and `workflow_state_id` dimensions, AND semantics, at most **one rule per exact scope**. Four scopes exist (global, `project`, `state`, `project ∧ state`); issues are not a rule dimension — a per-issue **pin** (below) covers that case.

A rule's payload is an **ordered list of targets** — `{ runner, tier? }` entries forming a preference order, e.g. "reviews go to Gemini on `cheapest`, else Claude, else my laptop" (`gemini:cheapest claude laptop-m4` in the CLI). For a dispatchable issue the supervisor:

1. Picks the **most specific matching rule**: `project ∧ state` > `project` > `state` > global. This deliberately swaps the context system's state-over-project tie-break: context ordering merely sequences a merge in which every layer still applies, but routing is winner-take-all and answers "who owns this work" — and ownership, including security boundaries like "acme work never leaves my laptop," is project-shaped. The `project ∧ state` scope remains the escape hatch for per-stage exceptions within a project. No merging, no fallback to broader rules.
2. Walks that rule's targets in order and assigns the first whose runner is not paused, online, and under its own `max_concurrent`, the active quota policy, and every applicable budget — resolving the entry's tier (or the runner's `default_tier`) to the model the run will use.
3. If the list is exhausted, the issue waits for the next dispatch pass — visible in the dispatch explainer (below), never silent.

Because a more specific rule silently wins, the rule editor warns at **authoring time** when scopes shadow each other: saving a state rule notes which project rules will take precedence for some projects ("acme issues in Review will use the acme rule instead"), and vice versa — the interaction surfaces when the rule is written, not as explainer archaeology after the fact.

**Pinning.** An issue may set `pinned_runner_id` (and optionally a `pinned_tier`) — UI, or `tines issues assign <ref> <runner>[:tier]`. A pin replaces rule matching entirely for that issue: only the pinned runner is considered (quota, budgets, and liveness still apply). `assign` with `--clear` unpins. Pinning does not bypass eligibility — a pinned issue in `awaiting_human` still waits.

### Quota policies

Two layers, deliberately different in kind:

- **Per-runner caps always apply.** `max_concurrent` on each runner is a physical fact (a laptop runs one agent well; a provider has its own concurrency limits) and is never bypassed.
- **One user-chosen quota policy** governs the total picture. The policy is a typed JSON setting so new policies are additive; v1 ships two:

| Policy | Config | Semantics |
| --- | --- | --- |
| `global_cap` (default) | `{ "type": "global_cap", "limit": 3 }` | At most `limit` runs in `launching`/`running` across everything. |
| `state_roster` | `{ "type": "state_roster", "default_limit": 1, "overrides": { "<state_id>": 3, … } }` | At most N concurrent runs per workflow state (counted by the issue's state at dispatch), with a fallback default and per-state overrides — a roster of "how many agents may work this stage at once". |

The roster's counting key is the run's **`state_id_at_start`** — a run whose agent has already moved the issue onward still occupies its starting state's slot until it ends. Strictly the roster bounds "runs started from this state," which approximates "agents working this stage"; the approximation is deliberate (the runner *is* still busy) and the counting query never joins the issue's live state.

Anticipated-but-not-shipped policy types (e.g. `per_project`) slot into the same `{ "type": … }` shape. Spend is deliberately **not** a policy type — concurrency and money are orthogonal, so budgets are their own always-on layer (below) rather than something you trade the roster for. The active policy is edited on the Agents tab; changing it affects future dispatches only — running work is never killed by a policy change.

Provider-side limits (e.g. Gemini's plan concurrency) are not modeled; hitting one surfaces as a launch error handled by the launch-failure path below. Set runner `max_concurrent` at or under the provider's limit.

### Usage, pricing, and daily budgets

**The usage ledger.** Every run records usage — `input_tokens`, `output_tokens`, `cost_usd?`, and a `cost_source` (`provider` | `priced` | `none`):

- `claude_managed`: the session's cumulative `usage` — token counts and `list_cost`, a native dollar figure at list rates — polled each sweep and finalized at run end (`cost_source: provider`).
- `gemini_managed`: token usage from the interaction's step events; dollars computed by Tines from the pricing table (`cost_source: priced`).
- `local`: whatever the harness reports in the daemon's `finish` payload — Claude Code's JSON output includes tokens and cost (`provider`); codex reports tokens at best (`priced`); a custom harness may report nothing (`none`).

Usage records carry `cache_read_tokens`/`cache_write_tokens` alongside input/output where the provider reports them, and the pricing table prices cache classes where rates are known — cache-heavy runs would otherwise misprice badly. **Token limits compare against `input_tokens + output_tokens`** (cache reads excluded); a provider-native figure like Gemini's `max_total_tokens` may count more (thinking tokens), which is fine — it is a per-run ceiling, not ledger arithmetic.

Runs with `cost_source: none` count zero toward dollar budgets but are **visibly flagged** in the ledger and UI — unknown spend is surfaced, never silently treated as free. The **pricing table** ships in code (per model id: $/Mtok by class), with user overrides editable in supervisor settings; **provider-reported cost always wins over the table** for the same run. Usage on a model with no price is *unpriced*: it counts zero dollars (tokens still count) — the gate deliberately **fails open, loudly**: a warning banner on the Agents tab, a badge on the runner's card and the run row, and a `runner.unpriced_usage` event (once per runner + model per day) all fire until a price is entered. Entering one **retroactively reprices the current window's** already-recorded unpriced runs — the tokens are on record and the math is trivial, and otherwise today's meter would stay wrong all day after the fix; closed windows stay as-recorded (the ledger is a control knob, not an invoice). Dollar budgets are soft against unknown models by design; token budgets remain exact. Unpriced (tokens known, no rate — fixable, carries the warning treatment) and unreported (`cost_source: none` — no tokens at all, permanent) are **visually distinct markers** throughout.

**Daily budgets — an always-on layer, not a quota policy.** The global budget (supervisor settings) and each runner's optional budget can each set a **daily USD limit**, a **daily token limit**, or both; whichever trips first stops new dispatches at that level. Mechanics:

- The **day window** resets at midnight in a configured IANA timezone (supervisor setting, defaulting to the creator's — same convention as schedules). **Usage accrues to the window in which it is observed** — each poll's delta and each final report land in the current day — never to the run's start day: a run started at 23:50 cannot spend all of today against yesterday's closed window, and the "today" meter always reflects what the gate sees.
- **Enforcement is a dispatch gate**: before assigning, the supervisor tallies the window's usage — ended runs plus the latest polled usage of in-flight ones — against the global budget and the candidate runner's. A target over either is skipped (the explainer says "budget exhausted — resets at 00:00 Europe/London"); running work is never killed by a budget. Raising a ceiling mid-day is just editing the number: budget writes are among the opportunistic dispatch triggers (see the dispatch loop), so the bump un-sticks dispatch in seconds, not at the next sweep.
- **Overshoot is bounded, not eliminated**: in-flight runs finish, so a day can exceed its limit by at most the in-flight runs' per-run caps (the managed-runner defaults below make this bound real out of the box; a runner with its caps removed is bounded only by `max_run_minutes` × burn rate, and the budget UI says so).

**Per-run caps** put a hard ceiling under each attempt, mapped to provider-native mechanisms wherever one exists: a runner may set `max_run_cost_usd` and/or `max_run_tokens`. For Claude, `max_run_cost_usd` becomes the session's platform-enforced `budget.max_list_cost` (the session pauses at the cap; the supervisor treats a budget-paused session as ended and cancels it). For Gemini, `max_run_tokens` becomes `agent_config.max_total_tokens`. For local runs the daemon cancels the harness when reported usage crosses the cap. **Defaults: managed runners are created with `max_run_cost_usd` $5** (shown, editable, and removable in the setup flow); local runners default to none, since their usage often arrives only at run end — `max_run_minutes` remains the universal backstop everywhere.

### Runs

An **agent_run** is one attempt at one issue by one runner:

```
assigned → launching → running → completed | failed | timed_out | canceled
```

- **assigned**: created by the dispatch pass; the claim on the issue starts here. Managed runners move to `launching` in the same pass; local runs wait for the daemon's next poll. An `assigned` run not acknowledged within 5 minutes fails at launch (see below).
- **launching**: the provider session is being created / the daemon is materializing the workspace.
- **running**: the agent is working. The run records `provider_session_id` and a `provider_url` when one exists (Gemini interactions are inspectable in AI Studio's logs; local runs have none).
- Terminal states record `ended_at`, an optional `error`, and the issue's state at start and end.

**Timeout.** Each runner config carries `max_run_minutes` (default 30). The sweep marks overdue runs `timed_out`, cancels the provider session (`POST /interactions/{id}/cancel` for Gemini; the sessions API's cancel for Claude) or instructs the daemon to kill the process.

**Judging the end — the attempt budget.** A run that ends is judged by what **it** did, not by where the issue happens to sit — the actor model makes this queryable: did any `issue.transitioned` event **authored by this run's key** occur during the run?

- Yes: the run **advanced** the work — even A→B→A wandering counts as engagement, and a strike would misread it. The issue's `attempt_count` resets to 0; if its current state is still eligible, it simply re-enters the pool. Note that an agent transitioning its issue between two `active` states does **not** hand it to another agent mid-run — the run's exclusive claim holds for its whole duration. Only after the run ends does the issue re-enter the pool, **in its new state**, so routing re-evaluates and a different rule may now match: issues move through the pipeline changing runners and tiers as they go, which is the payoff of "category is the whole rule." A consequence worth naming: nothing limits consecutive active→active hops — an agent-to-agent ping-pong never strikes out, since every run advanced — so the guard rails for that are budgets and quotas, not the strike system.
- No — whether the run `completed` quietly, `failed`, or `timed_out`: that is a **strike**. A transition performed by someone *else* during the run (a human, a schedule) neither credits the run nor blocks the strike — the agent still did nothing. `attempt_count` increments; at `attempt_limit` strikes (supervisor setting, default 3) the issue is **parked**: `needs_attention` is set, an `issue.parked` event fires, and the supervisor won't touch it again until a human acts. Parking is cleared by an explicit resume (`tines issues resume <ref>`, or the banner button in the UI) or by any **non-run-key transition** — that is the definition of "manual" throughout this spec; resuming resets `attempt_count`.
- **Launch failures are not strikes.** A run that never reached `running` (provider 429/5xx, daemon didn't ack) records the error on the run, and the dispatch pass retries the issue with the next runner in the preference list — or waits with backoff (2× per consecutive failure, max 1 h, tracked per runner). Repeated launch failures flag the *runner* (an error surfaced on its card and a `runner.errored` event), not the issue: the issue didn't fail, the pipe did. Persistent failures **escalate**: after ~10 consecutive failures the card badge is promoted to a full-width Agents-tab banner with the unpriced-usage warning's visual weight — a dead credential must not hide behind a quiet badge and an hourly retry indefinitely. Still no auto-pause; just louder. A successful launch clears the failure count, badge, and banner.

Cancel (`tines runs cancel <id>` / UI) is always available and is judged like any other end (usually a strike, unless the agent had already transitioned the issue). In the UI, cancel sits behind a confirmation that states the strike cost when one applies ("this run hasn't moved the issue yet — canceling counts as a strike, 2 remaining") and offers an **optional comment**, posted atomically *before* the cancellation — the sanctioned cancel-correct-redispatch maneuver, where sub-second re-dispatch can never race past the correction. A corrective comment does not change strike semantics — that would be invisible magic.

### Authentication: ephemeral per-run keys

Two credential kinds, sharply separated:

- **Runner tokens** (local runners only): long-lived, minted at registration, hashed at rest, sent by the daemon on every call. They can only hit the runner protocol endpoints (poll, log append, finish) — never issue actions. A compromised or lost token is **re-minted in place** (`tines runners rotate-token <name>` or the runner card's action): the old token is invalidated, the new one shown once, and the daemon's next poll gets a 401 with a clear message until the user drops the new token into its config — the same hand-off as first registration. No identity churn: the runner row, history, and rule references are untouched. Delete-and-re-register is deliberately not the rotation story.
- **Run keys**: at launch, the supervisor mints an API key row bound to the run (`agent_run_id` set, `expires_at` = launch + `max_run_minutes` + **10 minutes slack**; raising `max_run_minutes` mid-run does not extend already-minted keys). It is the agent's `TINES_API_KEY`, with issue-action authority — but **fenced off the control plane**: run keys get 403s on `/runners*`, `/routing-rules*`, `/supervisor/settings`, `/issues/:id/resume`, and key management, each pointing at the `Context change:` proposal convention. An agent must not be able to raise its own budget, un-park itself, re-route work, or touch credentials — the same affordance asymmetry AGENT_EDITING established, here enforced rather than merely un-advertised, because these endpoints control money and credentials. (Ordinary named API keys keep their phase-one full authority; the fence is on run keys only.) The key is **revoked when Tines detects the run's end** — immediately for daemon-reported finishes, at the next sweep for provider-detected ones — with expiry as the backstop for a crashed supervisor. A leaked key dies with the run.

**Attribution.** Comments and events made with a run key resolve through the run to the runner: rendered as "via ***laptop-m4*** · run on demo/12" — parallel to "via *api-key-name*" and "via schedule *name*". The actor model gains no new cases; a run key is an `api_key` row with extra provenance.

**Delivery of the run key** avoids putting secrets in prompt text wherever the platform allows:

- `gemini_managed`: the environment's network allowlist **`transform`** injects `Authorization: Bearer <run key>` on requests to the Tines API host at Google's egress proxy — the key never enters the sandbox. The same mechanism injects the GitHub credential (below).
- `claude_managed`: a per-run **vault** environment-variable credential (`TINES_API_KEY`, plus `TINES_API_URL`, `allowed_hosts` restricted to the Tines API host), created at launch tagged with the run id, deleted at run end, passed via `vault_ids` alongside the standing GitHub credential. Deletion can fail (provider error, worker eviction), so the sweep also garbage-collects: vault credentials tagged with ended runs are deleted on sight — an orphan holds only an already-revoked key, but it must not accumulate.
- `local`: the daemon receives the key in the (runner-token-authenticated) poll response and sets `TINES_API_KEY`/`TINES_API_URL` in the harness environment — the phase-one convention exactly.

### Credentials for source access

The user stores one **GitHub PAT** (fine-grained, scoped to the repos their context items point at) in supervisor settings — encrypted at rest with a server-held secret (a Workers secret binding; AES-GCM in D1), write-only after saving (only a fingerprint is shown). It is used natively per runner type:

- `gemini_managed`: passed at every launch in the environment config — repo `sources` seeding authenticates the clone, and allowlist `transform` entries for `github.com` / `api.github.com` inject it at the egress proxy for pushes and API calls. (The Interactions API has no provider-side secret store; per-launch passing is the documented mechanism, and the proxy keeps it out of the sandbox.)
- `claude_managed`: written **once** at runner setup into an Anthropic **vault** as a `GITHUB_TOKEN` environment-variable credential with `allowed_hosts` `github.com`/`api.github.com`; the runner config stores the vault id and every session binds it. Rotating the PAT in Tines rewrites the vault credential.
- `local`: ignored. The device's own git credentials/SSH agent are used; nothing to configure.

Tines holding the PAT is a deliberate trade accepted after research: Gemini's API structurally requires per-launch credential passing, so a durable store must exist somewhere, and one credential with one rotation point beats three.

**The PAT's repo scope is a confidentiality boundary, not hygiene.** Proxy/vault injection keeps the token *string* out of the sandbox, but the agent wields its full authority on every allowlisted request — and launch prompts embed issue comments and descriptions verbatim, so an injected instruction can direct an agent to read one in-scope private repo and push its contents to another. Scope the fine-grained PAT to exactly the repos your context items point at, and treat that set as the blast radius of any compromised run. (Per-project PAT overrides are a natural follow-up if one boundary proves too coarse; the same reasoning applies to the Tines-host injection, which is why run keys are control-plane-fenced above.)

### Workspace setup and launch

The supervisor assembles the launch materials **at launch time, not at claim time**: for managed runs that is the same pass; for local runs it is **poll-delivery** — the moment the daemon receives the assignment — so a prompt is never minutes stale, and `state_id_at_start` is set at that same moment. (The context spec's "read context after the transition" note was written for a supervisor that transitions on claim; this one doesn't, so the operative rule is simply *read at launch*.) If the issue is no longer eligible when a local assignment is delivered — transitioned away, parked, run canceled — the assignment is canceled instead of launched. The materials are: the **launch prompt** (`GET /api/v1/issues/:id/prompt` — stitched context + issue block, unchanged) prefixed by a generated **supervisor preamble**. The preamble is the directive text the context spec deferred to this phase, and it exists only on supervisor launches — the plain `/prompt` endpoint stays factual. It states: what run this is (runner name, run id, timeout), how authentication works in this environment (per the delivery mode above), where the workspace materials are (below), and the contract — *comment progress as you go; before finishing, transition the issue with one of its available transitions; work you cannot finish gets a handoff comment and a transition to the appropriate state*.

**The CLI ships into every workspace** — the issue block and journal sections teach `tines …` commands (context spec, AGENT_EDITING), so those commands must actually run where agents run. The CLI publishes a **self-contained single-file build** (`tines.cjs`, zero dependencies, CI-guarded under Gemini's 1 MB inline-source cap) alongside the npm package, and gains one auth behavior: with no API key configured it sends **no** `Authorization` header (for environments where a proxy injects one), and it reads config from a `TINES_CONFIG` file as well as env vars. Per environment:

- **Gemini**: the single-file build and a config file (`{ api_url, auth: "proxy" }`) are seeded via inline sources; the preamble aliases `tines` to `node /workspace/bin/tines.cjs`. Auth headers come from the egress proxy — the sandbox never holds the key.
- **Claude**: the preamble's bootstrap installs the published package (`npm i -g @tines/cli`); `TINES_API_KEY`/`TINES_API_URL` are already in the environment via the per-run vault credential. If the install is blocked by network policy, the preamble notes that every CLI command is a thin wrapper over `/api/v1` and gives the base URL, so `curl` is the fallback.
- **Local**: the daemon's machine already has the CLI; the daemon exports `TINES_API_KEY`/`TINES_API_URL` into the harness environment.

Per runner type:

- **`gemini_managed`**: one `POST /v1beta/interactions` with `background: true`, the configured agent, the tier-resolved model (and `max_total_tokens` when `max_run_tokens` is configured) in `agent_config`, the full prompt as `input`, and an `environment` carrying: each effective repo as a `sources` `repository` entry (cloned to `/workspace/<dir>` per the context bundle's resolved dirs), each effective skill's files as `inline` sources under `/workspace/skills/<name>/…` (skill caps fit comfortably under the inline limits), the CLI single-file build and its proxy-auth config (above), and the network allowlist with the GitHub + Tines-host transforms.
- **`claude_managed`**: a session against the run's tier-resolved managed agent (with the session `budget` set when `max_run_cost_usd` is configured), the prompt as the initial user message, `vault_ids` = [GitHub vault credential, per-run Tines-key credential]. The sandbox is not file-seeded at launch (the API has no such input); instead the preamble's bootstrap section instructs the agent to clone the effective repos itself (`GITHUB_TOKEN` is in its environment) and fetch its skills from `GET /api/v1/issues/:id/context` — self-seeding over the same API everything else uses.
- **`local`**: the poll response hands the daemon the run's launch payload: the prompt text, the effective-context bundle (same shape as `tines issues context --json`), and the run key. The daemon writes the bundle to a fresh per-run workspace directory (exactly the `--out` layout: `prompt.md`, `skills/…`, `repos.json`), clones/fetches the repos listed in `repos.json` with the device's own credentials, then launches the harness — `claude -p "$(cat prompt.md)"` in the workspace, `codex exec` equivalently, or the custom template — capturing stdout/stderr.

### Monitoring

- **Log tail.** Every run carries an append-only log, capped at 256 KB with truncation from the head (`log_bytes_dropped` records how much scrolled off). Local daemons POST chunks as the harness emits output. For managed runs, each supervisor sweep polls the provider (Claude session events list; Gemini interaction `steps`) and appends a rendered summary of new events — tool calls, messages, status changes — since the last poll.
- **Status.** Sweeps also reconcile run status from the provider (`completed`/`failed`/`cancelled` interactions; session status events) and run the end-judgment above.
- **Surfaces.** The run page and `tines runs show <id> --logs` render the tail (the web view auto-refreshing while `running`); `provider_url` links out to AI Studio's logs page for Gemini runs where deep transcripts live. The issue's comment thread remains the durable narrative — logs are for debugging, and the preamble's contract keeps agents narrating in comments.
- **Dispatch explainer.** `GET /api/v1/issues/:id/dispatch` answers "why isn't this running?": eligibility checks with pass/fail, the matched rule (or none), per-runner verdicts (paused / offline / at cap / quota), park status, the active run if any, and — when the verdict is eligible-but-waiting-for-capacity — the issue's **queue position** ("3 eligible issues ahead of this one" in the oldest-`updated_at`-first queue), which turns "waiting" into a forecast and makes the touch-an-issue-and-it-moves-back mechanic visible. The CLI (`tines issues dispatch <ref>`) and the issue page's agent panel render it — quota decisions must never be archaeology.

### The dispatch loop

Two triggers, one code path:

- **Opportunistic**: after any event that can change eligibility (`issue.created`, `issue.transitioned`, run end, resume, runner poll bringing capacity online) — and after any **settings write that can unblock dispatch**: budget edits (global or per-runner), quota-policy changes, the kill switch flipping on — the API layer schedules a dispatch pass via `ctx.waitUntil` — the fast path, sub-second from "moved to Open" to "assigned", and a raised budget ceiling un-sticks dispatch in seconds rather than waiting out the sweep.
- **Sweep**: a Cron Trigger every 5 minutes (`"*/5 * * * *"` added alongside the scheduled-tasks cron in the existing custom worker entry) runs the same pass, plus the monitoring poll, timeout and offline-runner enforcement, launch-failure backoff retries, launch reconciliation (below), and cleanup of expired keys and orphaned vault credentials. The sweep is the guarantee; opportunistic passes are the latency optimization — a `waitUntil` promise that rejects or a worker evicted mid-pass is invisible by design, and only the sweep makes dispatch reliable.

**Claim atomicity — the guarded INSERT.** D1 has no interactive transactions, and the schedules sweep's single-row CAS does not cover this shape: a claim needs *aggregate* guards. Each claim is therefore **one self-guarding statement** — an `INSERT INTO agent_run … SELECT …` whose `WHERE` re-checks, inside the statement, that no active run exists for the issue, the issue is still eligible, the runner is under `max_concurrent`, and the quota policy's count (global, or the roster count for `state_id_at_start`) is under its limit. Zero rows inserted means another pass won the race — never an error. A pass dispatching several issues issues one guarded statement per claim, sequentially, so its own earlier claims count against later guards. **Budgets and pricing are deliberately outside the guard**: their tally needs polled usage and pricing math, so they are an advisory pre-read per pass — two racing passes can each pass the budget check and overshoot by one dispatch, which the per-run caps bound; concurrency correctness never depends on them.

**Launch reconciliation.** The provider call cannot be inside any D1 statement, so a crash between "run marked `launching`" and "`provider_session_id` recorded" would otherwise orphan a live, billing session. Two defenses: every provider session/interaction is **tagged with its run id at creation** (Claude session `metadata`; Gemini the interaction title), and the sweep fails `launching` runs older than 5 minutes with no recorded session — then, where the provider API supports listing, cancels any session tagged with a run id that is unknown or already ended.

### Local runner protocol

```
POST /api/v1/runners/register     user API key auth → { runner, runner_token }   (token shown once)
POST /api/v1/runners/:id/poll     runner-token auth; heartbeat + { owned_runs: [run_id, …] } →
                                  { assignments: [ { run, prompt, bundle, run_key, timeout } ],
                                    cancels: [run_id, …] }
POST /api/v1/runs/:id/logs        runner-token auth; { chunk } appended
POST /api/v1/runs/:id/finish      runner-token auth; { status: 'completed'|'failed', error? }
```

Protocol semantics that make daemon failures survivable:

- **Delivery is one-shot.** Handing an assignment to a poll response is the same guarded `assigned → launching` state flip as everything else — a run is delivered exactly once, so two daemons mistakenly sharing one runner token cannot both execute it (the config-copied-to-two-terminals case). Sharing a token is still wrong — the daemons fight over heartbeat and assignments interleave arbitrarily (last-poller-wins) — but it degrades to confusion, not duplicate work.
- **`owned_runs` reconciles reality.** Each poll reports the run ids the daemon is actually executing; the supervisor fails any of that runner's `running` runs *not* in the list (the daemon restarted and lost them) rather than waiting for the timeout.
- **`cancels` means kill, not finish.** A run id in a poll response's `cancels` list tells the daemon the supervisor has already settled that run's fate (cancel, timeout, the offline sweep): kill the process now and do **not** `finish`-report it — a suspended-then-woken harness whose run was failed while the machine slept is killed without being re-reported as a fresh failure.
- **The daemon persists a state file** (run id → PID, workspace path, run key fingerprint) in its config dir. On startup it kills orphaned harness processes from a previous life, `finish`-fails their runs, and removes their workspaces — a crashed daemon must not leave a zombie Claude Code spending against a still-valid key.

The daemon ships in the CLI package as **`tines runner daemon`** (flags/config: `--name`, `--harness claude-code|codex|custom`, `--command <template>`, `--max-concurrent`, `--poll-interval` default 15 s). First start with a user `TINES_API_KEY` registers and persists the runner token to the CLI config; subsequent starts reconnect as the same runner. It polls, launches assigned runs (up to its cap), streams logs, kills on cancel, timeout, or per-run cap breach, reports finishes, and cleans up workspaces. Ctrl-C fails its in-flight runs gracefully via `finish` before exiting.

## Data model (D1 / Kysely)

```
runner            id, user_id, type, name, status, max_concurrent, max_run_minutes,
                  default_tier, tiers(JSON)?,       -- per-tier model overrides
                  budget(JSON)?,                    -- { daily_usd?, daily_tokens?, max_run_cost_usd?, max_run_tokens? }
                  config(JSON),            -- non-secret config (harness, per-tier agent ids, vault id, hostname)
                  secret_enc?,             -- encrypted provider API key (managed types)
                  runner_token_hash?,      -- local type
                  last_seen_at?, launch_failures, backoff_until?, created_at, updated_at
                  -- unique (user_id, name)

agent_run         id, user_id, issue_id, runner_id, status,
                  tier, model?,                     -- resolved at launch
                  usage(JSON)?,                     -- { input_tokens, output_tokens,
                                                    --   cache_read_tokens?, cache_write_tokens?,
                                                    --   cost_usd?, cost_source }
                  state_id_at_start, state_id_at_end?,
                  provider_session_id?, provider_url?, api_key_id?,
                  log TEXT, log_bytes_dropped, error?,
                  created_at, started_at?, ended_at?
                  -- index (issue_id, created_at); partial index on active statuses for quota counts;
                  -- index (user_id, created_at) for the day-window budget tally

routing_rule      id, user_id, project_id?, workflow_state_id?, targets(JSON), created_at, updated_at
                  -- targets: ordered [ { runner_id, tier? } ]; one rule per exact scope (API-enforced)

supervisor_settings  user_id PK, enabled, quota(JSON), attempt_limit,
                     budget(JSON)?,                 -- { daily_usd?, daily_tokens?, timezone }
                     pricing(JSON)?,                -- per-model-id price overrides
                     github_pat_enc?, github_pat_hint?, updated_at

issue             + pinned_runner_id?, pinned_tier?, attempt_count, needs_attention
api_key           + agent_run_id?, expires_at?      -- run keys; NULL for ordinary keys
```

Events (open string types, named after their table like `scheduled_task.*`): `runner.registered`, `runner.updated`, `runner.removed`, `runner.errored`, `runner.unpriced_usage`, `agent_run.started` (payload includes tier and resolved model), `agent_run.ended` (payload: status, outcome `advanced`/`stalled`, runner name, states, final usage), `issue.parked`, `issue.resumed`, `settings.updated` (supervisor settings, secrets elided). Supervisor-initiated events are attributed to the owning user with the run identified in the payload, rendered "via *runner* · run …" — the schedules-sweep pattern.

## API

Beyond the runner protocol above, same conventions as ever (`/api/v1/*`, session or key auth, cross-user 404, structured 422s, shared types in `@tines/shared`):

| Method & path | Purpose |
| --- | --- |
| `GET/POST /api/v1/runners` | List / create (managed types; secrets accepted on create, write-only after) |
| `GET/PATCH/DELETE /api/v1/runners/:id` | Read / update (pause via `status`, caps, tiers, budget, config, rotate secret) / remove — refused (422 naming them) while it has active runs or is referenced by any routing rule or pin; `force: true` strips those references with events |
| `POST /api/v1/runners/:id/rotate-token` | Local runners: invalidate the runner token and return a fresh one (shown once); the runner row, history, and rule references are untouched |
| `GET /api/v1/runs` | List; filters `issue`, `runner`, `active=true` |
| `GET /api/v1/runs/:id` | Read incl. log tail |
| `POST /api/v1/runs/:id/cancel` | Cancel a run |
| `GET/POST /api/v1/routing-rules`, `PATCH/DELETE /:id` | Manage rules (one per exact scope; 422 on scope collision; targets validated against the user's runners and the tier set) |
| `GET/PUT /api/v1/supervisor/settings` | Kill switch, quota policy, attempt limit, global budget, budget timezone, pricing overrides, GitHub PAT (write-only; reads return the hint) |
| `GET /api/v1/usage` | The ledger summarized: totals for a window (`window=today` default, or `from`/`to`) — tokens, USD, per-runner and per-tier breakdowns, unpriced/unreported counts — plus remaining headroom against each budget |
| `GET /api/v1/issues/:id/dispatch` | The dispatch explainer (now including per-target tier resolution, budget verdicts, and queue position when waiting for capacity) |
| `POST /api/v1/issues/:id/resume` | Clear `needs_attention`, reset `attempt_count` |
| `PATCH /api/v1/issues/:id` | Gains `pinned_runner_id` and `pinned_tier` (nullable) |

Run keys cannot call the runner protocol, and are fenced off the control plane (`/runners*`, `/routing-rules*`, `/supervisor/settings`, `/issues/:id/resume`, key management) with 403s pointing at the proposal convention; runner tokens cannot call anything but the protocol endpoints. Key-management endpoints keep refusing all bearer-key auth as in phase one.

## CLI

```
tines runners list | show <name> | pause <name> | resume <name> | remove <name>
             | rotate-token <name>            # invalidate + re-mint a local runner's token
tines runner daemon [--name …] [--harness claude-code|codex|custom] [--command <tmpl>]
                    [--max-concurrent n] [--poll-interval s]
tines runs list [--issue <ref>] [--runner <name>] [--active]
tines runs show <id> [--logs] | cancel <id>
tines routing list | set [--project <name>] [--state <wf>/<state>] <runner>[:tier] [<runner>[:tier]…] | clear […]
tines issues assign <ref> <runner>[:tier] | assign <ref> --clear
tines issues dispatch <ref>                  # the explainer, human-readable; --json for structure
tines issues resume <ref>                    # un-park
tines supervisor status | enable | disable   # kill switch + a one-screen overview
tines supervisor quota global <n> | roster --default <n> [--state <wf>/<state>=<n>…]
tines supervisor budget [--daily-usd <n>] [--daily-tokens <n>] [--tz <iana>] [--clear]
tines runners budget <name> [--daily-usd <n>] [--daily-tokens <n>]
                    [--max-run-usd <n>] [--max-run-tokens <n>] [--clear]
tines runners tiers <name> [--default <tier>] [--set <tier>=<model>…] [--unset <tier>…]
tines usage [--window today|--from <date> --to <date>] [--by runner|tier]
```

All support `--json`. `runs show --json` includes the full stored log tail and provider link, so "what did the agent do" is scriptable.

## Web UI

A new **Agents** tab (`/agents`), plus touches on the issue page:

- **Agents tab** — three stacked sections:
  - **Runners**: a card per runner — type icon, name, status dot (online/offline/paused), active runs vs. cap, last seen, launch-error badge when backing off. Card actions: pause/resume, edit, remove. "Add runner" walks the per-type setup (paste an API key → validated with a ping; local shows the copy-pasteable `tines runner daemon` bootstrap with the register step explained).
  - **Runs**: the run list, `active` filter on by default — issue ref, runner, tier + resolved model, status (live-updating), duration, cost (with an "unpriced"/"unreported" marker where applicable), started. A row expands to the log-tail viewer (monospace, follows while running, "N KB truncated" header when clipped) with the cancel dialog (confirmation + strike note + optional atomic comment, per the Runs concept section) and provider-console links. Managed-run rows, the log viewer, and the spend meter carry a **"last updated Xs ago" hint** — their logs and cost advance only at sweep cadence, and a quiet log must read as "not polled yet," not "agent stuck"; local runs stream continuously and need none.
  - **Automation settings**: the kill switch (prominent; off for new users, its disable confirmation offering the bulk cancel of in-flight runs, and a persistent off-state banner shown on the tab — and "Automation is off" in every explainer — while disabled), quota policy picker (a segmented control revealing the policy's fields — the roster editor lists states grouped by workflow with per-state number inputs over the default), attempt limit, the **daily budget** fields (USD, tokens, timezone) with a live spend meter for today's window, the pricing-override table, and the GitHub PAT field (fingerprint + replace). An **unpriced-usage warning banner** tops the tab whenever a USD budget is set and unpriced usage accrued in the current window, naming the model and linking to the pricing table. Runner cards show their own budget meter when a per-runner budget is set, and their tier mapping (default tier badged; overridden tiers listed) in the edit view.
- **Routing** lives where scope lives, mirroring context's pattern: rules editable on the Agents tab (all scopes, with scope chips), plus inline "agent routing" rows on project and workflow-state detail surfaces showing the rule that would apply there.
- **Issue detail** gains an **Agent activity** panel: the dispatch explainer's verdict in one line ("Eligible — waiting for capacity on *laptop-m4*" / "Not eligible — state Human Review"), the pin control, and this issue's runs with expandable logs. A **parked banner** (amber, above the fold) appears when `needs_attention` is set: "Agents struck out 3 times here — last run ended without progress" with a **Resume** button and a link to the last run's log.
- **Transition dialogs prompt for an optional comment**, posted atomically with the transition — the natural "send back with feedback" gesture cannot race sub-second dispatch past its correction. This mirrors the cancel dialog's atomic comment: one habit, applied at both human interruption points. The API and CLI keep raw semantics; comment-first is the documented pattern there. Formal transition requirements (e.g. required comments) remain future work.
- Run status changes animate per the house motion rules; the runs list uses the same live-entering treatment as the activity feed.

## Testing

Provider calls sit behind a per-type **adapter interface** (launch, poll, cancel, credential setup) so unit tests exercise dispatch, quotas, strikes, and parking against fakes. The e2e suite drives the real loop with a stub adapter that "runs" instantly and a real `tines runner daemon --harness custom` pointed at a script harness, using the existing `--test-scheduled` hook to fire sweeps deterministically.

## Acceptance criteria

1. Register a local runner via `tines runner daemon`; it appears online on the Agents tab. Create a global routing rule listing it. Move an issue to an `active` state: within one poll interval the daemon receives the assignment, the workspace contains `prompt.md` (supervisor preamble + stitched context + issue block), `skills/…`, and the cloned repos, and the harness launches with `TINES_API_KEY` set.
2. The agent's comments and transition render as "via *runner-name* · run …" in the thread and activity feed; the run key is revoked as soon as Tines detects the run's end — immediately on a daemon-reported finish, by the next sweep for a provider-detected one — after which a held copy gets 401s. A run key attempting `PUT /api/v1/supervisor/settings`, a routing-rule write, a runner write, or `resume` gets a 403 naming the proposal convention.
3. Configure a `gemini_managed` runner with a Gemini API key; a dispatched issue produces a background interaction whose environment seeds the effective repos and skills and injects the GitHub PAT and run key at the egress proxy; sweeps append its steps to the log tail and the run row links to the provider console. A `claude_managed` runner launches a session bound to the GitHub vault credential and a per-run Tines-key credential, and the agent self-seeds per its preamble.
4. Issues in `backlog`, `awaiting_human`, and `done` states are never dispatched; neither are blocked issues, duplicates, nor issues with an active run. The dispatch explainer states the reason in each case.
5. With `global_cap` limit 2 and three eligible issues, exactly two run; the third launches when one ends. Switching to `state_roster` with a per-state limit enforces per-state counts. A runner at `max_concurrent` is skipped in favor of the next runner in the rule's list.
6. A run that ends without moving its issue strikes it; after 3 strikes the issue parks — banner shown, no further dispatch — and `tines issues resume` (or a manual transition) revives it with the attempt count reset. A provider 429 at launch does not strike the issue: the run records the error, the runner backs off, and the issue retries.
7. A run exceeding `max_run_minutes` is timed out and its provider session canceled / local process killed. `tines runs cancel` works mid-run.
8. Pinning an issue to a paused runner leaves it waiting with the explainer saying so; unpausing dispatches it. Flipping the kill switch (or pausing a runner) stops new dispatch and cancels not-yet-acknowledged `assigned` runs in its scope, while `launching`/`running` runs finish.
9. Every lifecycle moment — registration, run start/end, parking, resuming, settings changes — appears in the activity feed with correct attribution, and no secret (PAT, provider key, run key, runner token) ever appears in any response, event payload, or log after write.
10. A rule targeting `gemini:cheapest` launches the interaction on the runner's cheapest-tier model; overriding that runner's `cheapest` to an exact model id changes the next launch; an entry with no tier uses the runner's `default_tier`; the run row records tier and resolved model in the UI, CLI, and API.
11. With a global daily budget of $5, runs accrue provider-reported (Claude, Claude Code) or table-priced (Gemini, codex) cost in the ledger — attributed to the window in which it is observed; once today's tally crosses $5 no new run launches — the explainer names the budget and its reset time — while in-flight runs finish, bounded by the managed runners' default $5 per-run caps. A per-runner daily token limit gates only that runner. `tines usage` and the settings spend meter agree with the ledger. Usage on a model missing from the pricing table still dispatches (fail-open) but raises the warning banner, runner/run badges, and a `runner.unpriced_usage` event; entering a price clears them. A newly created Claude/Gemini runner carries `max_run_cost_usd` $5 by default, applied as the session `budget.max_list_cost`; a Gemini run with `max_run_tokens` carries `max_total_tokens`.
12. An agent inside the Gemini sandbox runs `tines issues move …` via the seeded single-file CLI with no key in the sandbox (proxy-injected auth); an agent in the Claude sandbox installs the CLI per its preamble and does the same with the vault-provided key. The issue block's commands are runnable, verbatim, in every environment.
13. Kill the daemon mid-run: the harness orphan is killed and its run failed on daemon restart (or the run is failed by `owned_runs` reconciliation / the 5-minute offline rule, whichever comes first). Two concurrent dispatch passes over the same eligible issue produce exactly one run (guarded INSERT); a worker evicted between launch and `provider_session_id` write leaves a `launching` run that the sweep fails within 5 minutes, and a provider session tagged with an ended run id is canceled by reconciliation.

## Resolved questions

From the design discussion:

- **Architecture**: hybrid — the worker is the sole supervisor and launches managed agents directly; local devices run a polling daemon. No inbound connections, no external brain.
- **Runner model**: a uniform registry; managed integrations and local daemons are rows of one `runner` table so routing, quotas, and monitoring have one vocabulary.
- **Routing**: scoped, ordered preference lists (context's scope dimensions, one rule per exact scope, most specific wins, no cross-rule fallback) plus a per-issue pin that overrides rules entirely. Specificity puts **project above state** (`project ∧ state` > `project` > `state` > global) — deliberately unlike context's merge ordering, because routing is winner-take-all and ownership is project-shaped.
- **Eligibility**: category is the whole rule — `active` means agents may take it; no per-state flags. Readiness (dependencies spec), the exclusive claim, parking, and the kill switch are the only additional gates.
- **Quotas**: one user-chosen typed policy (`global_cap` or `state_roster` now; more types additive) over always-on per-runner caps.
- **Gemini provider**: the Gemini Interactions API managed agents (Antigravity), not Jules — chosen for API-first environment control (repo/file seeding, egress-proxy credential injection, background execution) despite Jules' built-in GitHub App, which required its own web-app onboarding.
- **Source credentials**: one Tines-held GitHub PAT, encrypted at rest — forced by Gemini's per-launch credential model; written through to an Anthropic vault for Claude runners at setup; unused by local runners, which keep their device credentials.
- **Agent auth**: ephemeral per-run keys with full owner authority (no scoped permissions yet — consistent with phase one), delivered out-of-prompt (proxy header injection / vault env var / daemon env), auto-revoked at run end; separate long-lived runner tokens confined to the daemon protocol.
- **Run loop**: exclusive claim per issue; ends judged by whether the issue moved; strikes with a configurable attempt budget (default 3) then parking behind an explicit human resume; launch failures back off the runner instead of striking the issue.
- **Monitoring**: run rows with a 256 KB head-truncated log tail (daemon-streamed locally, sweep-polled from provider events), provider console links, a dispatch explainer, and an Agents tab + `tines runs` CLI over it all; issue comments remain the durable narrative.
- **Budgets**: a separate always-on layer, never a quota policy type — global and per-runner daily limits, each optionally USD and/or tokens, whichever trips first; day windows reset at midnight in a configured timezone; enforcement is a dispatch gate (in-flight runs finish, overshoot bounded by per-run caps). Dollars come from provider-reported cost where native and a built-in, override-editable pricing table otherwise; unreported usage counts zero but is always flagged.
- **Per-run caps**: mapped to provider-native ceilings — Claude's platform-enforced session `budget.max_list_cost`, Gemini's `max_total_tokens`, daemon-side cancellation for local — with `max_run_minutes` as the universal backstop.
- **Model tiers**: a closed three-tier vocabulary (`smartest` / `balanced` / `cheapest`) chosen at the routing layer (`runner:tier` entries and pins), resolved by the runner — built-in per-type defaults, per-runner overrides to exact model/config, per-runner `default_tier` (default `balanced`). Claude tiers are lazily provisioned managed agents (model lives on the agent object); Gemini and local pass the model per launch; runs record requested tier and resolved model.

From the spec review (adversarial pass, findings triaged with the user):

- **Claim atomicity**: spelled out as a per-issue guarded `INSERT … SELECT` carrying the no-active-run, eligibility, runner-cap, and quota-count checks inside one statement — D1's batch CAS idiom generalized to aggregate guards; budgets are an advisory pre-read outside the guard, their races bounded by per-run caps. The sweep, not `waitUntil`, is the reliability guarantee.
- **Launch reconciliation**: provider sessions are tagged with their run id at creation; the sweep fails session-less `launching` runs after 5 minutes and cancels provider sessions tagged with unknown/ended runs.
- **Run-key fence**: run keys (only) are 403-fenced off the control plane — runners, routing rules, supervisor settings, resume, key management — so an injected agent cannot raise its own budget, un-park itself, or touch credentials. Ordinary named keys keep phase-one full authority.
- **CLI in sandboxes**: decided to *ship the CLI* rather than fall back to HTTP-styled prompts — a dependency-free single-file build seeded into Gemini (with proxy-auth config; no key in the sandbox) and npm-installed in the Claude sandbox via the preamble, so the issue block's commands run everywhere; curl noted as the last-resort fallback.
- **PAT blast radius**: named explicitly as the confidentiality boundary of a compromised run, not scoping hygiene; per-project PATs noted as the follow-up if needed.
- **Daemon failure model**: one-shot assignment delivery (guarded state flip), `owned_runs` reconciliation each poll, a persisted run→PID/workspace state file with orphan-kill on restart, and a 5-minute offline rule that fails a dead runner's running runs.
- **Overshoot honesty**: managed runners default to a $5 `max_run_cost_usd` (visible, removable) so the budget-overshoot bound is real as shipped; local runners stay uncapped with `max_run_minutes` as backstop.
- **Unpriced usage**: fails open, loudly — dispatch continues, but banner, badges, and a `runner.unpriced_usage` event fire until a price is entered; entering one retroactively reprices the current window (closed windows stay as-recorded); provider-reported cost always beats the table.
- **End judgment**: a run advanced the work iff a transition *authored by its run key* occurred during the run; "manual" (which clears parking) means any non-run-key transition. Final-state comparison was dropped — it misjudged A→B→A and credited human transitions to idle agents.
- **Window attribution**: usage accrues to the window in which it is observed, so long runs cannot spend today against yesterday's closed window.
- **Tier-agent drift**: each provisioned Claude agent stores the model it was built for and is updated/re-provisioned on mismatch at launch; the agent objects carry no directive system prompt — the per-session launch prompt remains the single home for direction.
- **Runner deletion**: reject-by-default naming referencing rules/pins; `force` cascades with events — no dangling routing targets or permanently stuck pins; rules the cascade empties are flagged "no targets," never deleted.
- **Timing**: launch materials assemble at launch/poll-delivery (never claim time); ineligible-by-delivery assignments cancel. Run-key expiry slack is 10 minutes; the sweep garbage-collects expired keys and orphaned per-run vault credentials.
- **Conventions**: events renamed `agent_run.*` to match the table-name convention (`scheduled_task.*` precedent); `state_roster` counts by `state_id_at_start`; token limits compare `input + output`, with cache token classes recorded and priced where known.
