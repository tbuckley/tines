# Supervisor — User Flows

> **Decision amendment (2026-09-09):** The historical off-by-default and first-time arming
> passages below are superseded by [automation enabled by default](./AUTOMATION_DEFAULT_2026-09-09.md).

Twenty user flows derived from [SPEC.md](./SPEC.md), ordered from the core automation loop outward to niche and operational flows. Each was reviewed individually; **Decisions** sections record the calls made during that review, including a few deliberate deltas from SPEC.md (collected at the end).

## Contents

**Core — the automation loop**

1. [First agent, end to end](#1-first-agent-end-to-end)
2. [The happy-path run](#2-the-happy-path-run)
3. [Add a managed runner](#3-add-a-managed-runner)
4. [Watch a run in flight](#4-watch-a-run-in-flight)
5. ["Why isn't this running?"](#5-why-isnt-this-running)
6. [The handoff loop](#6-the-handoff-loop)

**Control & steering**

7. [Route different work to different runners](#7-route-different-work-to-different-runners)
8. [Pin an issue to a specific runner](#8-pin-an-issue-to-a-specific-runner)
9. [Parked issue rescue](#9-parked-issue-rescue)
10. [Steer the next attempt](#10-steer-the-next-attempt)
11. [Pause and the kill switch](#11-pause-and-the-kill-switch)

**Money & capacity**

12. [Set and hit a daily budget](#12-set-and-hit-a-daily-budget)
13. [Tune concurrency](#13-tune-concurrency)
14. [Tier and model overrides](#14-tier-and-model-overrides)
15. [The unpriced-model warning](#15-the-unpriced-model-warning)

**Niche / operational**

16. [Rotate credentials](#16-rotate-credentials)
17. [Remove a runner safely](#17-remove-a-runner-safely)
18. [Daemon lifecycle on a dev machine](#18-daemon-lifecycle-on-a-dev-machine)
19. [Audit what agents did](#19-audit-what-agents-did)
20. [A misbehaving provider](#20-a-misbehaving-provider)

Plus: [Spec deltas from this review](#spec-deltas-from-this-review) · [Future work](#future-work)

---

## 1. First agent, end to end

**Persona & starting point:** an existing Tines user (projects, workflows, issues, context items from phase one) who has never used the supervisor. They want their laptop to start working the backlog with Claude Code.

1. They open the new **Agents tab**. Before their first run it leads with the **first-run checklist** (Tines/253) rather than the off-state banner: seven derived items — issue, CLI, runner, rule, automation, issue content, first run — each carrying the control that completes it, ticking live and retiring account-wide once one run exists. No runners, no rules, and the kill switch is **off** (the default for a new user — see Decisions).
2. They click **Add runner → Local**. The UI shows a copy-pasteable bootstrap: `tines runner daemon --name laptop-m4 --harness claude-code`, with the registration step explained (first start with their `TINES_API_KEY` registers and persists a runner token).
3. In a terminal, they run the command. The daemon registers, stores its token, and starts polling. Back in the browser, the runner card appears: online dot, 0/1 runs, hostname/platform.
4. Still on the Agents tab, they create a **global routing rule** targeting `laptop-m4` (no tier — the runner's `default_tier`, `balanced`, applies). The empty state nudged them here (see Decisions).
5. They flip the **kill switch** on. Automation is now armed — dispatch begins immediately if eligible work exists.
6. They move an issue to an `active` state (board drag or `tines issues move`). Within one poll interval (~15 s), the daemon receives the assignment, materializes the workspace (`prompt.md` with supervisor preamble, `skills/`, cloned repos with the device's own git credentials), and launches `claude -p`.
7. In the UI, the issue's **Agent activity panel** shows the run: `running`, tier + resolved model, live log tail. The agent's comments appear in the thread as "via ***laptop-m4*** · run on demo/12".
8. The agent finishes, transitions the issue to the review state, and the run ends `completed` / outcome `advanced`. The runner card goes back to 0/1; the activity feed shows the whole lifecycle.

**Success criterion:** from empty Agents tab to a completed, attributed run without touching anything except the Agents tab, one terminal command, and one board move.

**Decisions**

- The kill switch (`enabled`) is **off by default** for a new user. Creating a routing rule signals intent, but budgets aren't configured yet; enabling is an explicit act.
- The Agents tab **empty state nudges toward rule creation** when a runner exists but no rules do ("you have a runner but no rules — nothing will dispatch"), since a rule-less setup silently does nothing.

---

## 2. The happy-path run

The steady-state loop once setup is done — the flow that happens dozens of times a day, seen from the human's perspective.

**Persona & starting point:** setup from flow 1 exists (runner online, rule in place, supervisor enabled). The user is triaging their board.

1. The user grooms an issue — solid description, context items covering the repo, maybe a comment with specifics — and drags it from `Backlog` to `Open` (an `active` state).
2. **Dispatch is sub-second** via the opportunistic pass: the issue's Agent activity panel flips from "Not eligible — state Backlog" to an active run almost immediately (local runners add up to one poll interval before the harness actually launches).
3. The user doesn't watch. They move on to other triage. The issue's **board card shows a run indicator** (see Decisions) — an agent is on it, and the run's exclusive claim also signals "hands off, someone's working."
4. The agent narrates in the issue thread per the preamble contract: progress comments as it goes, each attributed "via ***laptop-m4*** · run on demo/12". These land in the activity feed too, so the feed becomes a live picture of what the fleet is doing.
5. The agent finishes: pushes a branch/PR via the device's git credentials, leaves a wrap-up comment, and transitions the issue to `Human Review` (an `awaiting_human` state) with one of its available transitions.
6. The run ends `completed` / outcome `advanced`; attempt count stays 0; the run key is revoked immediately (daemon-reported finish). The runner frees a slot and the dispatch pass immediately considers the next eligible issue — the queue drains itself oldest-`updated_at` first.
7. The user later reviews the issue: reads the thread narrative (comments are the durable record — no need to open run logs on the happy path), inspects the PR, and either finishes it (`Done`) or pulls it back to `Open` with a corrective comment — flow 6.

**Success criterion:** the user's only touchpoints are one board move at the start and one review at the end; everything between is legible from the issue thread alone, without ever opening the Agents tab or run logs.

**Decisions**

- **Board cards indicate active runs** (runner chip / status dot), so the board answers "what's being worked right now" at a glance. (Pairs with the parked marker from flow 9.)
- **No notification on agent handoff** to `awaiting_human` — single-user, so the awaiting-human column *is* the inbox.

---

## 3. Add a managed runner

**Persona & starting point:** the user from flow 1 wants cloud capacity — the laptop is one slot, and it's offline when the lid closes. They have an Anthropic (or Gemini) API key.

1. On the Agents tab they click **Add runner → Claude (managed)** (the Gemini path is symmetric; deltas below).
2. The setup form asks for: a **name** (e.g. `claude-cloud`), the **API key**, and shows adjustable defaults — `max_concurrent` 3, `max_run_minutes` 30, default tier `balanced`, and the **$5 per-run cost cap** (shown, editable, removable — keeps the budget-overshoot bound real out of the box).
3. On save, Tines **validates the key with a ping** before creating the row. A bad key fails the form inline; nothing is created.
4. **GitHub access:** if no PAT is stored yet in supervisor settings, the setup flow surfaces that here (see Decisions) — a managed runner without source access can't clone anything, so it inlines the "add your GitHub PAT" step (fine-grained, scoped to exactly the repos context items point at, with the blast-radius framing). For Claude, saving the PAT writes it through to an Anthropic vault credential and the runner stores the vault id; for Gemini it's passed per-launch via the egress proxy.
5. The runner card appears: type icon, always-online (managed), 0/3 runs, $5/run badge. The key is now write-only — the edit view shows only that a key is set, with a Replace action.
6. The setup wizard ends with a **skippable "add to routing" step** (see Decisions) — e.g. appending the runner to the global rule as a fallback (`laptop-m4 claude-cloud`).
7. First dispatch to a Claude runner **lazily provisions the tier's managed agent** (model lives on the agent object) — invisible beyond the run's `launching` state; the run row records tier + resolved model. Gemini needs no provisioning; the model is passed per interaction.
8. The run behaves exactly like flow 2 from the user's view — same thread narrative, same attribution — plus a **provider console link** on the run row (AI Studio for Gemini) for deep inspection.

**Gemini-specific deltas:** the form's agent name defaults to the current Antigravity preview id; cost shows as table-priced (`cost_source: priced`) rather than provider-reported.

**Success criterion:** paste a key, get a validated, capped, routable runner; the first dispatched run clones the right repos and narrates in the thread with no infrastructure the user can see.

**Decisions**

- **PAT storage stays in supervisor settings** (shared across managed runners), but the **managed-runner setup flow checks for it and inlines the add-PAT step** when missing — otherwise the first run fails cryptically at clone time.
- **Post-create routing nudge:** the wizard's final step offers adding the runner to a rule (skippable) — same principle as flow 1's empty-state nudge.

---

## 4. Watch a run in flight

**Persona & starting point:** a run is underway. The user is curious — or suspicious — and wants to see what the agent is actually doing right now.

**Entry points (two, converging on the same viewer):** the issue page's Agent activity panel, or the Agents tab's Runs section (`active` filter on by default) showing the fleet-wide picture: issue ref, runner, tier + resolved model, live status, duration, cost so far.

1. The user opens the Agents tab. Two runs are `running`, one is `launching`. Rows live-update; managed-run rows and the log viewer carry a **"last updated Xs ago" hint** (see Decisions), since their logs/cost advance only at sweep cadence (up to ~5 min), while local runs stream continuously.
2. They expand a row into the **log-tail viewer**: monospace, follows while running, and when the 256 KB cap has clipped the head, an "N KB truncated" header that links to the complete log. For a local run this is the harness's output live — rendered tool calls, shell commands, and agent messages; for a managed run it's the sweep-rendered event summary (tool calls, messages, status changes). Both read the same way.
3. Cross-checking the narrative: the log is the debugging view, the issue thread is the story — the run row links to the issue and vice versa.
4. **Deep inspection**: the truncation header's link (or `tines runs show <id> --logs --full`) serves every byte the run emitted, for local and managed runs alike, for 30 days after the run ends. `--raw` gets the unrendered harness stream. For managed runs a `provider_url` console link is still there when the provider's own transcript format is what's wanted.
5. **Intervention:** the viewer offers **Cancel**, behind a **confirmation dialog** (see Decisions) that states the strike cost when the run hasn't transitioned the issue ("this run hasn't moved the issue yet — canceling counts as a strike, 2 remaining"). Steering with a corrective comment is flow 10.
6. If the run ends while they watch: the row animates to its terminal status, records duration/cost/outcome, and drops off the `active` filter; the expanded log stays readable.

**CLI mirror:** `tines runs list --active` and `tines runs show <id> --logs`; `--json` includes the full stored tail for scripting.

**Success criterion:** at any moment the user can answer "what is the fleet doing, what has this run cost so far, and what is the agent doing on *this* issue" in under three clicks — and can stop any run from the same place they observe it.

**Decisions**

- **Staleness honesty:** managed-run rows, the log viewer, and the spend meter show "last updated Xs ago" so a quiet log reads as "not polled yet," not "agent stuck." Local runs don't need it.
- **Cancel requires confirmation** — accidental cancellation is expensive (redone work), and the dialog states the strike cost so parking never comes as a surprise.

**Clarification recorded during review — active→active transitions:** an agent transitioning its issue between two `active` states does **not** hand it to another agent mid-run — the run's exclusive claim holds for its whole duration. After the run ends (judged `advanced`, attempt count reset), the issue re-enters the pool **in its new state**, so routing re-evaluates and a different rule may now match — issues move through the pipeline changing runners/tiers as they go. That chaining is the payoff of "category is the whole rule." Consequence: nothing limits consecutive active→active hops (an A→B→A ping-pong between agents never strikes out, since every run advanced) — the guard rails for that are budgets and quotas, not the strike system.

---

## 5. "Why isn't this running?"

**Persona & starting point:** the user moved an issue to `Open` expecting flow 2, but nothing is happening. This flow is the dispatch explainer doing its job: quota decisions must never be archaeology.

1. They open the issue. The **Agent activity panel's verdict line** answers the common cases in one sentence: "Eligible — waiting for capacity on *laptop-m4*", "Not eligible — state Human Review", "Parked — agents struck out", "Automation is off".
2. For more, they expand the panel (or run `tines issues dispatch demo/12`), which renders the full explainer:
   - **Eligibility checks, pass/fail:** effective state category is `active` ✓; ready (no open blockers, not a duplicate, not effectively done) ✗/✓; no active run ✓; not parked ✓; kill switch on ✓.
   - **Routing:** the matched rule and its scope ("state rule: Review"), or "no matching rule — automation is opt-in via rules" with a link to create one.
   - **Per-target verdicts**, in preference order: `gemini (cheapest → gemini-flash-lite)` — daily budget exhausted, resets at 00:00 Europe/London; `claude` — at max_concurrent (3/3); `laptop-m4` — offline (last seen 12 min ago).
   - **Pin status**, if pinned: only the pinned runner is evaluated, and the explainer says so.
   - **Queue position** when eligible but capacity-bound (see Decisions): "3 eligible issues ahead of this one" in the oldest-`updated_at`-first queue.
3. Each verdict points at its remedy, and the remedies are the other flows: blocked → resolve the blocker; no rule → create one (flow 7); parked → resume (flow 9); runner offline → restart the daemon (flow 18); budget → wait or raise it (flow 12); at cap → wait, or bump `max_concurrent`. From Tines/256 the same remedies appear **fleet-wide** on the Agents tab's Now row, as controls beside each waiting group, for the operator who is asking about the whole fleet rather than one issue.
4. The user fixes the actual cause, and because every fixing action fires an opportunistic dispatch pass, the panel flips to an active run within seconds — closing the loop in the same view they diagnosed it in.

**Success criterion:** for any idle issue, the user reaches a specific, actionable reason — never "it just isn't running" — in one click or one command, and the fix takes effect visibly in the same place.

**Decisions**

- **Queue position is included** when the verdict is "eligible, waiting for capacity" — it turns "waiting" into a forecast. It also makes the touch-an-issue-and-it-moves-back mechanic (dispatch is oldest-`updated_at` first) visible, which is a feature.

---

## 6. The handoff loop

**Persona & starting point:** the flow-2 agent finished its attempt and moved the issue to `Human Review` (an `awaiting_human` state). This flow is the round-trip — work bouncing between human and agents using nothing but the workflow graph, which is the *entire* automation boundary.

1. The user works their review column (their inbox, per flow 2). On an issue, the thread tells the story: the agent's progress comments, a wrap-up comment ("opened PR #47, tests pass, unsure about the migration ordering — see comment"), and the transition, all attributed "via ***laptop-m4*** · run …".
2. **Outcome A — it's good:** they merge the PR and transition the issue to `Done`. The supervisor never touches `done` states; the loop ends.
3. **Outcome B — needs another pass:** they transition it back to `Open`; the **transition dialog prompts for an optional comment** (see Decisions), so the correction ("migration ordering is wrong — B must run before A; also add a down-migration") and the transition land atomically. The transition *is* the dispatch trigger — no separate "re-assign" action exists. The next run's launch prompt embeds the thread, so the correction is read by the next agent; steering happens through comments, never mid-run chat.
4. The next run picks it up (possibly a different runner — routing re-evaluates in the current state), reads the thread including its predecessor's wrap-up and the human's correction, and continues rather than starting over — the PR branch and prior comments are its continuity.
5. **Outcome C — the agent shouldn't retry this one:** they keep it in `Human Review` (or any non-active state) and do it themselves. No pause, no pin, no opt-out flag: staying out of `active` states is the whole mechanism.
6. The reverse handoff happens mid-run without a human: an agent that gets stuck follows the preamble contract — handoff comment, transition to the appropriate `awaiting_human` state. That's judged `advanced` (it moved the issue), so a *deliberate* punt never costs a strike — strikes are only for runs that end without engaging at all.

**Success criterion:** the user drives the entire human↔agent relationship with the two verbs they already know — comment and transition — and the thread reads as a coherent conversation across human and agent turns.

**Decisions**

- **The UI prompts for an optional comment on any transition**, posted atomically with it. This closes the ordering footgun (sub-second dispatch racing a correction typed after the transition) for the natural "send back with feedback" gesture. Formal **transition requirements** (e.g. required comments per transition) are deferred to a future spec. API/CLI keep raw semantics — comment-first is the documented pattern there.
- **Reopen is not a strike** — confirmed intent. A bounce-back resets nothing (the last run advanced, so attempt count is already 0); an issue can loop human↔agent indefinitely without parking. Each round *is* progress; parking is only for agents spinning without engagement.

---

## 7. Route different work to different runners

**Persona & starting point:** the user now has three runners (`laptop-m4`, `claude-cloud`, `gemini`) and one global rule. They want smarter economics: cheap models for reviews, the good stuff for implementation, the laptop preferred when awake.

1. On the Agents tab's **Routing** section they see their rules as scope-chipped rows — currently one: `Global → laptop-m4, claude-cloud`.
2. They add a **state-scoped rule**: scope = workflow `Dev` / state `Review`, targets = `gemini:cheapest, claude-cloud:cheapest`. The editor validates targets against their runners and the closed tier set; one rule per exact scope, so a duplicate scope gets an inline error pointing at the existing rule to edit instead.
3. They add a **project-scoped rule** for a sensitive project: `project acme → laptop-m4` only — work on that repo never leaves the device.
4. **What wins:** most specific matching rule — **`project ∧ state` > `project` > `state` > global** (see Decisions — this deliberately swaps the context system's state-over-project tie-break) — with no merging and no fallback across rules. An `acme` issue in `Review` matches the `acme` project rule, so it stays on the laptop; the `acme ∧ Review` scope remains the escape hatch for per-stage exceptions within the project.
5. **Within** the winning rule, targets are tried in order: first runner that's unpaused, online, under its cap, under quota, under budgets gets the run, with the entry's tier (or the runner's default) resolved to a concrete model. List exhausted → the issue waits, visible in the explainer with per-target verdicts — never a silent fallback to a broader rule.
6. **Where routing is visible:** besides the Agents tab, project and workflow-state detail pages show an inline "agent routing" row — the rule that would apply there. The issue-level answer is always the explainer's matched-rule line.
7. CLI: `tines routing list`, `tines routing set --state dev/review gemini:cheapest claude-cloud:cheapest`, `tines routing clear …`.

**Success criterion:** the user can express "who works on what, in what order, at what tier" in a handful of legible rules, and for any given issue can see exactly which rule applied and why in one place.

**Decisions**

- **Routing specificity puts project above state**: `project ∧ state` > `project` > `state` > global. Rationale: context ordering answers "in what order do instructions stack" (all layers still apply — ordering only sequences the merge), while routing is winner-take-all and answers "who owns this work" — and ownership, including security boundaries like "acme never leaves my laptop," is project-shaped. This diverges from SPEC.md's "same specificity ordering as context layers" and must be stated explicitly in the spec, with this rationale.
- **Shadow hints at authoring time:** saving a *state* rule warns when project rules will take precedence for some projects ("acme issues in Review will use the acme rule instead"), and vice versa — surfacing the interaction when the rule is written instead of via the explainer after the fact.

---

## 8. Pin an issue to a specific runner

**Persona & starting point:** routing handles the general case, but this one issue is special — a gnarly refactor the user wants their strongest configuration on — without touching any rule.

1. On the issue page's Agent activity panel, the user opens the **pin control** and picks a runner, optionally with a tier: `claude-cloud : smartest`. CLI: `tines issues assign acme/7 claude-cloud:smartest`.
2. The pin **replaces rule matching entirely** for this issue — only the pinned runner is ever considered. Everything else still applies: eligibility (a pinned issue in `Backlog` or `awaiting_human` still waits), the runner's cap, quota policy, budgets, liveness, parking.
3. The explainer reflects it: "Pinned to *claude-cloud* (smartest)" replaces the matched-rule line, with the single runner's verdict below. If the pinned runner is paused or at cap, the issue waits — and says so — rather than falling back to rules. Pinning to a paused runner is legal and simply waits.
4. The issue dispatches to the pinned runner; the run records `smartest` and the resolved model. **The pin survives the run** — it's issue state, not a one-shot — so every subsequent attempt (strikes, handoff round-trips) goes to the same runner until cleared.
5. **Clearing:** the pin control's ✕ / `tines issues assign acme/7 --clear`. The issue reverts to rule matching on the next pass.
6. **Lifecycle edges:** deleting the pinned runner is refused naming this pin; `force: true` clears it with an event. No dangling pins.

**Success criterion:** a per-issue override in two clicks that is impossible to misread — the issue page always says it's pinned, why it's waiting if it is, and reverting is one action.

**Decisions**

- **Pins stay sticky** (the spec's model — one mechanism, predictable), with the **pin badge rendered prominently** on the issue and in runs-list rows so a stale pin is always visible rather than a surprise in the explainer.
- **Single-run pins** ("use smartest for the next attempt only") are **future work** — wanted eventually, not in this phase.
- Pinning without a tier uses the runner's `default_tier` — same rule as rule targets; confirmed intent.

---

## 9. Parked issue rescue

**Persona & starting point:** an issue has been quietly failing — three runs ended without the agent moving it. The supervisor has parked it. This flow is the human noticing, diagnosing, and reviving it.

1. **The user finds out** via any of: the amber **parked banner** on the issue page ("Agents struck out 3 times here — last run ended without progress", above the fold, with a Resume button and a link to the last run's log); the **amber parked marker on the issue's board card** (see Decisions); the `issue.parked` event in the activity feed; or the explainer verdict "Parked — needs attention."
2. **Diagnosis:** they follow the banner's link to the last run's log tail and skim the issue thread. Typical root causes and their tells:
   - the agent kept timing out (runs ended `timed_out` — task too big for `max_run_minutes`);
   - the agent finished "successfully" but never transitioned (`completed` quietly — didn't follow the contract, or genuinely couldn't act: missing context, repo access);
   - repeated failures (crash-looping harness, bad clone).
   The run rows on the issue's panel show all attempts with statuses — the pattern is visible at a glance.
3. **The fix** depends on the cause: sharpen the description, add a missing context item/repo, split the issue, raise the timeout, or pin it to a more capable runner/tier (flow 8).
4. **Revive — two paths, both intentional:**
   - **Explicit resume:** the banner's Resume button / `tines issues resume acme/9`. Clears `needs_attention`, resets `attempt_count`, fires `issue.resumed`, and the opportunistic pass dispatches immediately if eligible.
   - **Any manual transition** (non-run-key) also un-parks. Dragging the parked issue to another state *is* a resume; there is no way to accidentally leave it half-parked.
5. If nothing changed before resuming, the same failure likely recurs — three more strikes, parked again. The strike system doesn't diagnose; it refuses to burn quota forever. The banner's evidence links are what push toward fixing the cause.

**Success criterion:** a persistently failing issue costs at most `attempt_limit` runs before a human is loudly involved; from the banner, the user reaches the evidence in one click and revives in one click.

**Decisions**

- **Parked issues get an amber marker on their board cards** — the board distinguishes "waiting for capacity" from "given up, needs you." (Pairs with flow 2's run indicator.)
- **No "nothing changed since last attempt" nudge** on resume — dropped as too paternalistic.
- **The attempt limit stays a single global setting** (default 3) — no per-state/per-project limits this phase.

---

## 10. Steer the next attempt

**Persona & starting point:** the user is watching a run (flow 4) and can see from the log tail that the agent has misread the task — wrong approach, wrong files, heading somewhere expensive. There is deliberately no mid-run chat; this flow is the sanctioned maneuver: **cancel, correct, re-dispatch**.

1. From the log viewer they hit **Cancel**. The confirm dialog (flow 4) appears — including the strike note when the run hasn't transitioned the issue — and offers an **optional comment box** ("tell the next attempt what to do differently"), posted atomically before the cancellation (see Decisions).
2. The run ends `canceled`; the provider session is cancelled / the daemon kills the harness; the run key dies. Partial work survives wherever the agent put it (pushed branch, PR, comments) — nothing is rolled back.
3. With the run gone, the issue is immediately eligible again — and because the corrective comment landed atomically with the cancel, sub-second re-dispatch cannot race past it.
4. The comment sits in the thread ("Stop refactoring the parser — the bug is in the tokenizer, see test_edge_cases.py"), attributed to the user, right after the cancelled run's partial narrative.
5. The next dispatch pass launches a fresh run; its launch prompt embeds the thread, so the new agent reads its predecessor's progress comments *and* the correction, and picks up from the pushed branch rather than starting cold.
6. Variant — **steer without cancel:** if the run is nearly done or the correction isn't urgent, the user just comments now and lets the run finish; the *next* run reads it. Comments are never delivered mid-run.

**Success criterion:** redirecting a wayward agent is one dialog — stop it, say why — and the correction reliably reaches the next attempt without racing dispatch.

**Decisions**

- **Cancel-with-comment**: the cancel dialog gains the optional atomic comment, mirroring flow 6's transition-comment pattern — one habit, applied at both human interruption points.
- **Cancel remains a uniform strike** (unless the agent already transitioned the issue). A corrective comment does not change strike semantics — that would be invisible magic; and three cancels in a row earning a park banner is a reasonable outcome anyway.

---

## 11. Pause and the kill switch

**Persona & starting point:** something needs to stop — one scenario per scope. (a) The laptop is needed for a demo: pause one runner. (b) A bad context item is sending every agent down the same hole, or costs are spiking: stop the world.

**Pause one runner**

1. On the runner's card: **Pause**. CLI: `tines runners pause laptop-m4`. Status dot flips to paused.
2. Effects, immediately: no new assignments; its not-yet-acknowledged `assigned` runs are cancelled free (nothing was running; the issues return to the pool). `launching`/`running` runs finish normally — pause is "no new work," not "drop what you're doing."
3. Routing routes around it: rules that list it skip to the next target; issues whose only target (or pin) is the paused runner wait, with the explainer saying "paused."
4. **Resume** re-enables assignment; the opportunistic pass fires (capacity coming online is a dispatch trigger), so queued work flows within seconds.

**The kill switch**

5. Agents tab → Automation settings → the prominent **enabled** toggle. CLI: `tines supervisor disable`. Same semantics fleet-wide: all `assigned` runs cancelled, nothing new dispatches, in-flight runs finish.
6. When runs are in flight, the confirmation offers the **panic option** (see Decisions): "N runs still running — they'll finish (cost bounded by per-run caps). **Cancel them too?**" Bulk cancel = individual cancels (strikes and all), no new semantics — flipping the switch *and* taking the option is the full stop.
7. While off, the system is legible about it: every issue's explainer says "Automation is off," and the Agents tab shows a persistent off-state banner — nobody spends an afternoon debugging routing when the master switch is the answer.
8. Re-enabling dispatches the accumulated eligible backlog — subject to quotas and budgets, so it's a controlled drain, not a thundering herd.

**Success criterion:** "make it stop" is one obvious action at either scope — including a true stop-everything-now — takes effect instantly, and the system says loudly everywhere that it's off; resuming is equally one action.

**Decisions**

- **The kill-switch confirm includes bulk-cancel of in-flight runs** — panic is the actual use case, and hunting runs down one by one mid-panic is unkind.
- **Paused and offline are distinct states everywhere runners appear** (cards, explainer verdicts): paused is deliberate (supervisor-side gate; a paused local daemon keeps polling and heart-beating), offline means the daemon is gone. Same "not taking work," very different remedies.

---

## 12. Set and hit a daily budget

**Persona & starting point:** the first weeks of automation produced a surprising API bill. The user wants a ceiling: "never more than $10/day total, and Gemini specifically no more than $3."

**Setting it up**

1. Agents tab → Automation settings → **daily budget** fields: USD, tokens (either or both), and the reset **timezone** (defaulting to their own). They set $10, `America/New_York`. CLI: `tines supervisor budget --daily-usd 10 --tz America/New_York`.
2. On the `gemini` runner's card they set a per-runner budget: $3/day (`tines runners budget gemini --daily-usd 3`). Layering: global gates everything; per-runner gates that runner; whichever trips first stops dispatches at that level.
3. Next to the fields, a **live spend meter** for today's window — provider-reported cost (Claude, Claude Code) plus table-priced tokens (Gemini, codex) — matching `tines usage` and `GET /api/v1/usage` exactly. Runner cards with budgets show their own meter.

**Living with it**

4. Dispatch treats budgets as a gate: before each assignment, the window's tally (ended runs + latest polled usage of in-flight ones) is checked against global and candidate-runner budgets. Gemini crosses $3 mid-afternoon → Gemini targets are skipped; rules fall through to their next targets, so work continues elsewhere until the global $10 trips.
5. When the global budget trips: no new dispatches anywhere; **in-flight runs finish** (overshoot bounded by per-run caps — the $5 managed defaults make that bound real). Eligible issues queue.
6. The stop is legible: the explainer's per-target verdicts read "budget exhausted — resets at 00:00 America/New_York," and the Agents tab shows a banner next to the meter ("Global budget reached — dispatch resumes at midnight").
7. At midnight in the configured zone the window resets and the next pass starts draining the queue — oldest first, quotas still apply. No action needed.
8. **Raising the ceiling mid-day** is just editing the number — and budget edits fire an opportunistic dispatch pass (see Decisions), so bumping $10 → $15 un-sticks dispatch within seconds.

**Accuracy honesty, surfaced to the user:**

- Runs with `cost_source: none` count $0 but are **flagged** ("unreported") in the ledger and runs list — the meter's number is never silently wrong.
- Cost of in-flight managed runs advances at sweep cadence; the meter carries flow 4's "last updated Xs ago" hint.
- The unpriced-model case (counts $0, loud warnings) is flow 15.

**Success criterion:** a spending ceiling takes two fields to set, is enforced without killing work, shows exactly where today stands at a glance, and when it trips, both *that* it tripped and *when it un-trips* are stated everywhere the user might look.

**Decisions**

- **Budget edits (global and per-runner) join the opportunistic dispatch triggers** — SPEC.md's trigger list doesn't include settings changes, but a raised budget waiting up to 5 minutes for the sweep contradicts the fixes-take-effect-in-seconds experience taught everywhere else.
- **Token budgets get identical treatment** (fields, meter in tokens, same gate semantics) — no separate flow needed.

---

## 13. Tune concurrency

For a local runner, the machine owner first opts in with
`--allow-remote-concurrency --max-concurrent 4`. The Agents editor then labels the value
**Requested concurrency**, shows the effective cap and local ceiling, and reports
**Pending** until that daemon acknowledges the revision. Repeated polls, reconnects, and
ordinary restarts do not overwrite the request. Lowering below the active count lets those
runs finish but admits no new work. **At local ceiling** sends the operator back to the
machine; the web cannot enable opt-in or raise the ceiling.

**Persona & starting point:** the fleet is either drowning (six PRs landed in review at once) or starving (issues queue while runners idle). This flow is the two knobs — quota policy and per-runner caps — and knowing which to reach for.

1. **The default experience:** `global_cap` at 3. The user notices issues queuing ("Eligible — waiting for capacity", queue position from flow 5) while they could review more, and bumps the limit to 5 in the settings' quota section. Takes effect next pass; running work is never killed by a policy change.
2. **Switching policies:** the segmented control reveals the chosen policy's fields — **`state_roster`** shows the roster editor: **all** states grouped by workflow (including states with no override, shown inheriting the default — see Decisions), a default limit, and per-state number inputs over it (`Open: 3`, `Review: 2`). Semantics: "how many agents may work each *stage* at once" — the throttle moves from total volume to pipeline shape. CLI: `tines supervisor quota roster --default 1 --state dev/open=3 --state dev/review=2`.
3. One roster subtlety surfaces in the runs list rather than config: a run counts against the state it *started* from (`state_id_at_start`) until it ends, even if the agent already moved the issue on. The roster editor's helper text says "counted by the state a run started in."
4. **Per-runner caps** are the other knob, on the runner card: `max_concurrent` is the physical fact and is never bypassed by policy. Raising the global cap does nothing if every runner is saturated — the explainer's per-target verdicts point at which knob is binding.
5. **Utilization at a glance** (see Decisions): `tines supervisor status` and a line atop the Runs section show current usage against the active policy — "3/3 global slots in use" or "Open 3/3 · Review 0/2" — so saturation is visible without diagnosing a specific issue.

**Success criterion:** the user can shape *how much* runs at once (policy) independently of *what each machine can bear* (caps), see within one screen which limit is currently binding, and change either without disturbing running work.

**Decisions**

- **Roster default stays 1 for unlisted and newly created states**; the editor lists every state (grouped by workflow) showing the inherited default, so no state's limit is a surprise.
- **Utilization is included in the summary surfaces** — `tines supervisor status` and the Runs section header — cheap aggregation over data the guards already query. From Tines/256 the same surfaces carry the **Now row**: what is waiting, why, which limit binds, and the remedy for each group as a control.

---

## 14. Tier and model overrides

**Persona & starting point:** the built-in tier defaults are fine until they aren't — a new model ships that the user wants *now*, or "cheapest" should mean something better for review work.

1. **The default experience needs no flow:** tiers resolve via built-in per-type defaults maintained in code, updated as providers ship models. A user who never opens this UI gets sensible, current models — that's the point of the tier vocabulary.
2. **Viewing:** the runner's edit view shows its tier mapping — default tier badged, each tier showing its resolved model and whether it's built-in or overridden. Run rows already show `tier → model`, which is usually how the user first notices what "balanced" resolves to.
3. **Overriding a tier:** on `claude-cloud` they set `smartest` = an exact model id + settings (e.g. effort). CLI: `tines runners tiers claude-cloud --set smartest=<model-id>`. Unlisted tiers keep the built-ins. Two runners of the same type can disagree about "smartest" — deliberate.
4. **Changing the default tier:** `tines runners tiers laptop-m4 --default cheapest` — routing entries and pins without an explicit tier now resolve to `cheapest` on that runner.
5. **Effect timing:** next launch — resolution happens at dispatch; running work untouched. For Claude runners, a changed override triggers the anti-drift update/re-provision of the tier's managed agent at next launch — invisible beyond `launching` taking a moment longer.
6. **Removing an override** (`--unset smartest`) falls back to the built-in — and when built-ins move as models ship, un-overridden runners silently improve. An overridden tier is frozen until touched; the **stale-override marker** (see Decisions) keeps that honest.
7. **Validation:** overrides are checked per type where possible; a bogus model id surfaces as a launch failure on the runner card (flow 20) — never a strike on the issue.

**Success criterion:** the user thinks in `smartest`/`balanced`/`cheapest` everywhere, can redefine any of those words per runner in one field, and can always trace a run back to the exact model it used.

**Decisions**

- **Stale-override marker:** the tier editor shows a passive marker when an override points at a model older than the current built-in for that tier — informational only, no auto-migration.
- **Custom-harness runners** (no `{model}` placeholder) show "tiers don't apply to this runner" in the tier editor instead of dead fields; runs record the requested tier with model unknown, per the spec.

---

## 15. The unpriced-model warning

**Persona & starting point:** the user overrode a tier to a brand-new model id (flow 14) — or a provider default moved — and the pricing table doesn't know its rates. They have a $10 daily budget (flow 12), which just went partially blind. This is the fail-open-loudly path.

1. A run launches on the unknown model. **Dispatch is not blocked** — pricing gaps must never silently halt the fleet — but the run's cost is *unpriced*: tokens recorded exactly, dollars counting zero toward the USD budget.
2. The alarms fire everywhere at once: a **warning banner** atop the Agents tab (whenever a USD budget is set and unpriced usage accrued this window) naming the model and linking to the pricing table; an **"unpriced" badge** on the runner's card and affected run rows; a `runner.unpriced_usage` **event** (throttled once per runner + model per day).
3. The honest picture: the spend meter shows its dollar figure plus an "excludes N unpriced runs" annotation. Tokens for those runs remain visible, and token budgets stay exact — a user relying on token limits is unaffected.
4. **The fix:** the banner links to the **pricing-override table** in supervisor settings, pre-focused on the offending model id; the user enters $/Mtok rates (input, output, cache classes where relevant).
5. On save: the current window's already-recorded unpriced runs are **repriced retroactively** (see Decisions), the meter corrects, and the banner and badges clear. Future usage on the model is priced.
6. When Tines later ships the model's built-in price, it covers un-overridden users; a user override, if present, wins — same posture as tiers. Provider-reported cost, where native, always beats the table.

**Success criterion:** unknown pricing never stops work and never hides — the gap is visible within one sweep everywhere spend is displayed, and the distance from warning to fixed is one click and two numbers, with today's meter made right immediately.

**Decisions**

- **Retroactive repricing of the current window** when a price is entered: the tokens are recorded, the math is trivial, and otherwise today's meter stays wrong all day after the fix. Historical (closed) windows stay as-recorded — the ledger is a control knob, not an invoice.
- **"Unpriced" and "unreported" are visually distinct markers**: unpriced (tokens known, no rate) is fixable and carries this flow's warning treatment; unreported (`cost_source: none` — no tokens at all, e.g. a custom harness) is permanent and purely informational.

---

## 16. Rotate credentials

**Persona & starting point:** routine hygiene or mild alarm — a PAT is expiring, an API key may have leaked, or the user is tightening the PAT's repo scope after reading the blast-radius warning. Three credentials, three rotations, all write-only after save.

**Rotate the GitHub PAT**

1. Supervisor settings → the PAT field shows only a fingerprint/hint with a **Replace** action. The user creates a new fine-grained PAT on GitHub (scoped to exactly the repos their context items point at — the copy repeats the blast-radius framing), pastes it, saves.
2. Propagation is automatic per runner type: Claude runners' vault credential is rewritten (config keeps its vault id); Gemini passes the PAT per-launch, so the next launch carries the new one; local runners never used it.
3. After the replace, a transient note gives static guidance: **"safe to revoke the old token in N minutes"**, where N is the largest `max_run_minutes` across runners that use the PAT (see Decisions) — in-flight runs launched with the old credential are guaranteed done by then.

**Rotate a provider API key**

4. Runner card → edit → **Replace key**. Validated with a ping before saving; a bad key leaves the old one in place. In-flight sessions are unaffected; the next launch uses the new key.

**Rotate a local runner token**

5. **`tines runners rotate-token <name>`** (or the runner card's action — see Decisions): invalidates the old token and shows a new one **once**. The daemon's next poll gets a 401 and exits with a clear message until the user drops the new token into its config — same hand-off as first registration. No identity churn: the runner row, history, and rule references are untouched.

**The audit backdrop:** no secret ever appears in any response, event payload, or log after write; `settings.updated` / `runner.updated` events fire with secrets elided — the *fact* of rotation is in the feed, the *value* never is.

**Success criterion:** every stored secret can be replaced in one field with validation before commit, propagation needs no per-runner chasing, and the user knows exactly when the old credential is safe to revoke.

**Decisions**

- **Runner-token re-mint is v1** (`rotate-token` CLI + card action) — delete-and-re-register churns runner identity and was rejected as the remedy for a compromised token.
- **PAT revoke guidance is static**: "safe to revoke in N minutes" with N = max `max_run_minutes` over PAT-using runners — no live run tracking needed.

---

## 17. Remove a runner safely

**Persona & starting point:** the laptop is being wiped, or a managed-runner experiment is over. The runner is woven into rules and maybe pins — this flow is the reject-by-default delete doing its job.

1. Runner card → **Remove** (or `tines runners remove laptop-m4`). If the runner is unreferenced and idle, it's gone (with a `runner.removed` event); done. The dialog also mentions **pause as the softer alternative** (see Decisions) for the "might come back" case — pause keeps identity, rules, and history warm with zero dispatch.
2. Otherwise the delete is **refused with a 422 naming everything in the way**, rendered as a checklist in two categories:
   - **Active runs** (n running/launching/assigned) — always block; no force past them. Remedy inline: cancel them (flow 10's dialog, bulk if several) or wait.
   - **References** — routing rules listing it as a target, issues pinned to it — each named and linked, so the user can retarget by hand if they care where that work goes next.
3. **The deliberate path:** edit the named rules/pins, then remove the cleanly-unreferenced runner.
4. **The force path:** the confirm offers "Remove anyway" (`force: true`) once no active runs remain — referencing targets are stripped from their rules and pins cleared, each with its own event, so the feed records exactly what the cascade touched. Nothing dangles.
5. Consequences stated before the force commits: a rule whose target list becomes empty still exists but dispatches nothing — it's **flagged amber "no targets" in the routing list** (see Decisions) rather than deleted; formerly-pinned issues revert to rule matching. If this runner was the only route for some scope, that work stops being automated — visible per-issue via flow 5.
6. History survives: past runs keep their runner attribution in threads and the feed; the ledger's per-runner history remains queryable. Removal is about the future, not the past.
7. Cleanup by type: local — the daemon's next poll gets a 401 and exits; the removal UI reminds the user to delete its config/state dir. Claude — the runner's vault credential and provisioned tier agents are deleted best-effort at the provider.

**Success criterion:** it is impossible to remove a runner without either seeing exactly what depends on it or explicitly choosing the cascade — and after either path, no rule target, pin, or credential dangles, while history stays intact.

**Decisions**

- **Force-cascade flags emptied rules instead of deleting them**: the routing list shows an amber "no targets" state — the scope choice is user intent worth preserving, but the husk must be visible, not a trap flow 5 surfaces one issue at a time.
- **The removal dialog suggests pause** as the reversible alternative — one line of copy.

---

## 18. Daemon lifecycle on a dev machine

Remote concurrency consent is process/service configuration, not server state. `runner restart`
preserves it. To enable, disable, or change the ceiling, pause the runner, wait for zero active
runs, and relaunch or reinstall with the complete desired flags. A new daemon instance reports
policy before receiving work; a legacy or malformed report fails closed to local authority.

**Persona & starting point:** the local runner lives on a laptop that sleeps, reboots, changes networks, and occasionally has its terminal closed mid-run. This flow is the daemon being a well-behaved citizen of a messy machine.

**Normal operation**

1. **Start:** `tines runner daemon` (config persisted from first registration). It reconnects as the same runner, polls every 15 s, and the card flips online. If work is queued for it, the first poll delivers assignments.
2. **Day-to-day it's invisible:** polls heartbeat `last_seen_at`; assignments arrive, workspaces materialize, harnesses launch (up to `--max-concurrent`), logs stream, finishes report. The daemon docs (and the Add-runner bootstrap screen's "keep it running" footnote) include **launchd/systemd service snippets** (see Decisions).
3. **Graceful stop:** Ctrl-C. In-flight runs are `finish`-failed before exit (the supervisor knows immediately), workspaces cleaned. Card goes offline within 2 minutes.

**The messy paths**

4. **Lid closed / network drop, no runs in flight:** polls stop, card flips offline at 2 minutes, the supervisor routes around it. On wake, the first poll flips it online and — capacity being a dispatch trigger — queued work arrives within seconds. Zero user action.
5. **Daemon dies mid-run** (crash, `kill -9`, closed terminal): the harness may be orphaned. Three overlapping nets, whichever fires first:
   - **restart:** the state file (run → PID/workspace) lets the daemon kill orphans, `finish`-fail their runs, and remove workspaces;
   - **`owned_runs` reconciliation:** a restarted daemon that lost track reports what it actually owns; the supervisor fails the missing runs;
   - **the 5-minute offline rule:** no restart at all — the sweep fails its `running` runs (error `runner offline`) and revokes their keys, so an orphaned harness is spending against a dead key.
   All three read the same to the user: the run is `failed` with outcome **`interrupted`** — no strike, because the daemon died, not the work. The issue keeps its attempt budget and re-enters the pool in its current state (the reconciliation path queues a dispatch pass, so that is seconds rather than the next cron); a runner that keeps dropping runs is what gets flagged, backing off on its card exactly as a runner that keeps failing to launch does. Board, explainer and run rows reflect it.
6. **Sleep mid-run, wake later** (the subtle one): the harness was suspended, not dead. A short nap (<5 min): polls resume, the run continues. Longer: the sweep already failed the run and revoked its key — on wake, the daemon's next poll learns via `cancels` that the run is dead and **kills the still-suspended harness without re-reporting it as its own failure** (see Decisions). Wasted partial work is bounded; a re-run picks the issue up with the thread as continuity.
7. **Machine reboot:** combine 4 and 5 — on next daemon start (automatic under launchd/systemd), orphan cleanup runs against the state file, then normal polling resumes.
8. **A copied token starts a second daemon:** every current daemon boot sends a stable random instance id. The newly admitted boot atomically becomes current; the old boot's next poll gets `409 runner_conflict` before its `owned_runs` can interrupt the winner's work, logs that runner *name* was superseded, cleans up its local runs as interrupted, and exits. The winner's first trusted `owned_runs` report reconciles work the old boot left behind. This fence deliberately remembers only the immediate predecessor, legacy daemons that omit the id remain compatible and unfenced, and a poll admitted just before takeover may finish. If launchd `KeepAlive` or systemd `Restart=always` keeps relaunching a duplicate service, stop/disable that service or register it under a separate runner name; process exit cannot disable an external service manager.

**Success criterion:** no daemon failure mode ever wedges an issue for longer than 5 minutes or leaves a harness spending against a live key; recovery from any of them is at most "start the daemon again," and the run record always says honestly what happened.

**Decisions**

- **Service-manager snippets ship in the docs** (launchd/systemd) — the runner is supposed to be infrastructure; docs-only, no product surface. Operators must disable a duplicate service sharing a token rather than letting two always-restart units repeatedly create new boots.
- **Spec clarification to carry into implementation:** a run id appearing in a poll response's `cancels` means "kill the process now; do not `finish`-report it" — the supervisor has already settled that run's fate.

---

## 19. Audit what agents did

**Persona & starting point:** end of the week. The user wants to answer three retrospective questions — *what happened*, *what did it cost*, *was it worth it* — without having watched any of it live.

**What happened**

1. The **activity feed** is the chronological record: every lifecycle moment — runner registered/paused/removed, `agent_run.started` (tier + resolved model in payload), `agent_run.ended` (status, outcome `advanced`/`stalled`/`interrupted`, runner, states, final usage), `issue.parked`/`resumed`, settings changes (secrets elided) — attributed "via *runner* · run …" alongside the human's own actions. Skimming it reads like a team standup log.
   Across the global, recorded, and issue feeds, run starts use a primary robot; completed runs use a green check; failed runs use a destructive X; and interrupted, stalled, timed-out, or canceled runs use an amber warning. Precedence is interrupted, failed, stalled, completed, then timeout/cancel. Unknown or malformed terminal payloads keep the muted robot, and the event sentence remains the accessible description.
2. Per issue, the **thread** is the durable narrative: agent comments, transitions, human corrections, in order. An issue's history is legible without ever opening a run log.
3. Per run, `tines runs list --runner gemini` / `--issue acme/7` filter the attempt history; `runs show <id> --json` includes the full stored log tail and provider link — greppable post-mortems across runs.

**What it cost**

4. `tines usage` (and `GET /api/v1/usage`): today by default, or `--from`/`--to` — totals in tokens and USD, `--by runner` / `--by tier` breakdowns, unpriced/unreported counts always alongside so the dollar figure carries its own caveats, plus remaining headroom against each budget. The Agents tab meter agrees by construction (same ledger).

**Was it worth it**

5. The pieces exist — outcome per run (`advanced`/`stalled`/`interrupted`) in `agent_run.ended` payloads and, persisted on the run itself, on run rows, cost per run on the run row — and the join is scriptable via `runs list --json`. No surface computes aggregate outcome rates in this phase (see Decisions).

**Success criterion:** any past action by any agent can be traced from feed → issue → run → log/provider console in a couple of clicks; every dollar figure is decomposable by runner/tier/day and never silently omits unknowns.

**Decisions**

- **No outcome-rate counters in v1** — per-runner advanced-%/cost analytics stay future work; the raw data is all queryable.
- **Ledger and run data retain indefinitely** for now — a conscious non-decision (single user, modest volume); retention design deferred.

---

## 20. A misbehaving provider

**Persona & starting point:** a provider is having a bad day — 429s, 5xx, an outage. The user shouldn't need to do anything, but should be able to see what's happening and trust that issues aren't being burned by infrastructure noise.

1. A dispatch pass assigns an issue to `claude-cloud`; the launch call gets a 429. The run records the error and ends without reaching `running` — **launch failures are not strikes**: the pipe failed, not the work.
2. **Same pass, next target:** the dispatcher retries the issue with the next runner in the rule's preference list — the ordered list is the failover mechanism. Work flows around the sick provider.
3. **The runner backs off:** consecutive launch failures double its backoff (2× per failure, max 1 h). During backoff the runner is skipped like a paused one, and the explainer says so ("backing off after launch errors — retrying in 12 min").
4. **The user finds out passively:** repeated failures flag the *runner* — an error badge on its card with the last error surfaced, plus a `runner.errored` event. Nothing demands attention; the system self-heals when the provider does (a successful launch clears the failure count and badge).
5. **Persistent failures escalate** (see Decisions): after ~10 consecutive failures, the badge is promoted to a full-width Agents-tab banner with the same visual weight as the unpriced-usage warning ("claude-cloud has failed to launch for 9 hours — invalid API key"). Still no auto-pause — just louder.
6. **Distinguishing the look-alikes** — the card's error text points the remedy:
   - **provider outage** (5xx/429): badge + backoff, self-healing — wait;
   - **bad credential** (401): same mechanics, but waiting never fixes it — the error says invalid key → flow 16;
   - **bogus model override**: fails only for runs resolving that tier — error names the model → flow 14;
   - **mid-run provider failure** (session dies after `running` started): a run failure, not a launch failure — judged normally (usually a strike), since Tines can't distinguish "provider died" from "agent died." Acceptable roughness; the run's error field tells the story if strikes accumulate.
7. If *every* route is sick (single-provider setups), issues just queue — eligible, waiting, explainer naming the backoff — and drain automatically when launches succeed again. The attempt budget was never touched, so nothing parked because of the outage.

**Success criterion:** a provider outage costs zero strikes, zero parked issues, and zero required user actions; the user can always distinguish "waiting out an outage" from "misconfigured and waiting forever" by reading the runner card's error.

**Decisions**

- **Escalation banner** after N (~10) consecutive launch failures: banner-weight visibility on the Agents tab, since a dead credential otherwise produces only a quiet badge and an hourly failure, indefinitely.

---

## Spec deltas from this review

> **Folded in.** As of this commit, all deltas below — and the flows' recorded Decisions and clarifications — have been folded into [SPEC.md](./SPEC.md), which is again the single authoritative document. This section stays as the review record.

Changes and clarifications this review makes relative to SPEC.md, to be reflected when the spec is next revised (now done — see the note above):

1. **Routing specificity swaps project above state** (flow 7): `project ∧ state` > `project` > `state` > global — a deliberate divergence from the context system's layer ordering, justified because routing is winner-take-all and ownership/security boundaries are project-shaped, while context ordering merely sequences a merge in which every layer still applies.
2. **Opportunistic dispatch triggers gain settings writes** (flow 12): global and per-runner budget edits (and by extension quota/settings changes that can unblock dispatch) schedule a pass, so fixes take effect in seconds, not at the next sweep.
3. **Dispatch explainer gains queue position** (flow 5) for the eligible-but-waiting verdict.
4. **Runner-token rotation is v1** (flow 16): `tines runners rotate-token <name>` + a runner-card action; old token invalidated, new one shown once, daemon re-auths like first registration.
5. **Retroactive repricing of the current window** (flow 15) when a pricing-table entry is added; closed windows stay as-recorded.
6. **Kill-switch bulk cancel** (flow 11): the disable confirmation offers cancelling all in-flight runs.
7. **Force-delete leaves flagged, not deleted, empty rules** (flow 17): amber "no targets" state in the routing list.
8. **Daemon `cancels` semantics** (flow 18): a cancelled run is killed without a `finish` report — stated explicitly.
9. **UI comment-on-interrupt pattern** (flows 6, 10): optional atomic comment on every transition and on run cancel.
10. **Escalated launch-failure banner** (flow 20) after ~10 consecutive failures.
11. **New-user default:** supervisor `enabled` is off until explicitly turned on (flow 1).

## Future work

Items deliberately deferred during this review:

- **Single-run pins** — "use this runner/tier for the next attempt only" (flow 8).
- **Transition requirements** — required comments or other preconditions on workflow transitions; the comment-on-transition prompt is the v1 nicety (flow 6).
- **Outcome-rate analytics** — per-runner advanced-% and cost-per-outcome surfaces (flow 19).
- **Ledger retention policy** — indefinite retention is the current conscious non-decision (flow 19).
- **Active→active ping-pong detection** — agent-to-agent transition loops never strike out; budgets/quotas are the only bound today (flow 4 clarification).

## Inspect the week (Tines/257, revised after Human Review)

1. Open **Agents → Analysis**, then open **State analysis · Last 7 days**. Choose **State project**, or keep All projects. It is the same scope as **Board project** on Now; highlights, changes and evidence use it, while Spend filters and chrome focus remain unchanged.
2. Choose **Most measured wait** to expand Timing and visits. Read the timed sample and excluded waiting/never-started visits, then **View stage capacity** to focus the currently saved global or roster limit. Inspect before deciding whether to edit.
3. Choose **Most send-backs**, or a stage’s sent-back share. Compare the previous share and percentage-point delta, then inspect each event’s issue, actor, related comment and historical prompt context ID/version. **Edit current stage prompt** is explicitly a current editor; a historical version is not a content snapshot.
4. Choose **Most failed starts** to inspect complete outcomes and recording coverage. **View stage runs** opens latest state/project runs with ended runs included, preserving the board filter; the list is not labelled as an exact seven-day cohort. Clearing the state keeps the project. Fleet utilization remains unfiltered.
5. Open a stage’s **Changes**, or the window’s changes list. Inspect dated Before/Since samples and nullable measures, then use the recorded event or setting link. Unequal periods and other edits prevent causal attribution. Markers remain reachable when no stage has work.
6. The weekly report loads on first open, retries inline after an error, and stays cached only while the same Analysis view and project remain mounted. The evidence dialog retains its frozen query through errors and Retry; closing or changing project invalidates late responses. Keyboard focus returns to its invoking control. The four-column overview becomes labelled stage cards on a phone, with all supporting measurements available in disclosures.

No number, highlight or delta changes dispatch, alerts, strikes or policy.
