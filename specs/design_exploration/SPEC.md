# Tines — Design Exploration Spec

A PRD says what a feature must do; it does not say what it should be like to use. This spec adds **design exploration**: a workflow that explores the UX for one brief in rounds — fanning each round out into parallel variant issues, having a fresh-context critic score every variant from the rendered page, gathering them into a gallery a human browses on a phone, and letting the human riff on the best one or select it — until a polished concept and a written spec exist for implementers. It is built for the HTML artifacts that landed with Tines/272 (a folder with `index.html` renders live in the app) and from the method in Anshu Chimala's *How to turn your AI into a world-class designer*: seed strings and named directions for divergence, a critic that sees the screen and not the story, restraint, and a human's taste at every branch.

Like the product-management spec, this ships **no code**: three workflows, their state prompts, one shared context base via state inheritance (Tines/238), four routing rules, and one quota override. Set up on 2026-09-07.

## Goals

- **Real divergence.** Variants are built in separate runs from separate seeds and directions, which is the one thing a single conversation cannot do.
- **Parallel rounds.** A round's variants build and get critiqued concurrently, each inside the run cap, and the parent waits without polling.
- **An honest critic.** The critic is a separate run with a fresh context, scores from screenshots and by using the prototype before reading the builder's rationale, and may send a variant back at most once.
- **The human at the branch points.** Picks, riffs, restarts and the final approval are transitions with a comment; nothing else needs them.
- **A handoff implementers can use.** The deliverable is a production-grade prototype plus a `ux-spec`, and the Engineering Design stage reads both.

## Non-goals

- **More than one round of automated critique per variant** (for now). The critic sends back once; the second critique scores and finishes. Raising this is a prompt edit, and the artifact version count is already the counter.
- **Image and video generation.** The site CSP blocks external fetches and generated media would need API keys on runners. Images shipped as files in the folder work today.
- **A design-system entity.** "Inside the app shell" is a constraint in the brief; the builder reads the real app.
- **Automatic selection.** The gallery ranks by score; a human always picks.

## Concepts

### Three workflows and a base

**`Design Craft`** is a base workflow with no transitions and one `backlog` state, `Craft`, whose `instructions` prompt holds the shared craft: what a self-contained prototype is (folder, `index.html`, viewport meta, no external resources, real content, 390 px first), how to be distinctive (seed + direction, boldness in one place, restraint), the **AI-tells list**, and the **critique rubric** — five criteria scored 1–10 (direction fit, execution, free of AI tells, phone, task clarity) with the overall being the *lowest*. Five states inherit from it, so the text lives once and the journal is shared (Tines/239): `Design Variant / Building` and `Critiquing`, `Design Exploration / Fanning out`, `Gathering` and `Polishing`. Nothing is ever created in `Design Craft`.

**`Design Variant`** is one variant of one round, a child issue of the exploration:

| State | Category | Meaning |
| --- | --- | --- |
| Building (initial) | active | Build, or revise after a critique, one prototype from the direction and seed in the description — or from the `Source:` prototype on a riff round, varying one named axis. Attaches `prototype` (folder) and `rationale`; comments one line. |
| Critiquing | active | A separate run. Renders and uses the prototype at 390×844 and 1440×900, scores the rubric, lists AI tells, names the three changes that raise the lowest score; attaches `critique` and `screenshots`. "Revise" only when this is the first critique and the overall is below the bar; otherwise "Finished". |
| Finished / Abandoned | done | Either unblocks the parent. |

Transitions: *Submit for critique* requires a fresh `prototype`; *Finished* requires a fresh `critique`; *Revise*; *Abandon*.

**`Design Exploration`** is the brief and the rounds:

| State | Category | Who | Meaning |
| --- | --- | --- | --- |
| Briefed (initial) | backlog | human | The brief: journey and user, requirements source (a `Direction:` pointer or inline), constraints, knobs `variants: 5` and `bar: 9`. Skipped by Backlog Triage. PM-filed explorations start in Fanning out. |
| Fanning out | active | agent | Round 1 diverges: 8–10 candidate directions with seeds, the `variants` most different from each other and from earlier explorations. A later round reads the human's comment: a named winner with what to keep and vary is a **riff** (children start from the winner's prototype, one axis each); "start over" is a fresh round steered away from what was rejected. Files one child per row directly in Building, carrying the parent's labels and a `Parent:` line, and links each as a blocker. Attaches `directions`. |
| Gathering | active, blocked | agent | Not dispatched until every child is done. Copies each finished child's prototype into `gallery/<letter>/`, writes a plain `index.html` ranking variants by score with relative links, attaches `gallery` (one version per round). |
| Concept Review | awaiting_human | human | Browse the gallery full page on a phone. *Next round* with a comment (riff or start over, optional knob overrides), *Select* with the winner, or *Abandon*. |
| Polishing | active | agent | The winner becomes a production-grade `concept` (all states, both viewports, decoration stripped, reconciled with the app's system when constrained) and a `ux-spec`. |
| Final Review | awaiting_human | human | *Approve* → Chosen; *Rework* → Polishing. |
| Chosen / Abandoned | done | | |

### The mechanics that make it work

- **Fan-out and wait** is the Planning/Delivering trick: children are linked as blockers *before* the parent transitions to Gathering, so an `active` parent is ineligible until the last child reaches a done state, then dispatches within a sweep.
- **The round counter is the artifact history.** Round *n* is `gallery` v*n* on the parent and `critique` v1/v2 on a child. The critic's "is this the first critique" check is the version number.
- **Fresh-context critic.** Building and Critiquing are different states, so different runs. The builder's one-line comment and separate `rationale` artifact keep the critic's launch prompt free of the story until it has scored.
- **Relative links inside one artifact.** Folder sites resolve `dir/` → `dir/index.html`, so a gallery links to `a/index.html` and each variant's own assets keep working after the copy.
- **Tiers.** Critiquing, Fanning out, Gathering and Polishing route to `smartest`; Building takes the global rule's default tier (the article's "smaller models to implement, larger to criticise"). The Building roster override lets a round build in parallel.

### Product-management hookup

The PRD's *Journeys* section ends with **UX exploration:** a one-line judgement call with its reason. The default is `none` — incremental UI on existing patterns (a field, a filter, a chip, a dialog) goes straight to engineering; an exploration is proposed for a new surface, a new interaction model, a redesign, a page whose point is how it feels, or a journey with several plausible shapes. Approving the PRD approves the line as written or as amended in the approval comment, which wins either way. Planning then files the exploration alone as the first tranche, directly in Fanning out with a `Direction:` line and the workstream label, blocking the direction; Delivering treats a Chosen exploration as "the next tranche implements it", and Planning files those issues with a `UX: <exploration ref>` line. The Engineering Design stage fetches `concept` and `ux-spec` when that line is present and designs to them.

## Acceptance criteria

1. A brief in Briefed, started by hand, produces `variants` child issues in Building within one sweep, each with a distinct direction and seed, all listed under the parent's "Blocked by"; the parent stays in Gathering undispatched until the last child is done.
2. Each child's critique is written by a run other than the one that built the prototype and records that scoring preceded reading the rationale; a child is sent back at most once.
3. The gallery renders live in the Artifacts panel with every finished variant reachable by tap, ranked by overall score, and a new version appears per round.
4. A riff comment produces children whose `Source:` is the named winner and whose directions each vary one axis; a "start over" comment produces directions absent from earlier rounds.
5. Select → Polishing → Final Review yields a `concept` and a `ux-spec`; an Engineering issue with a `UX:` line has a design doc that cites both.
6. A Product Direction whose PRD names a journey for exploration files the exploration first, wakes when it is Chosen, and files implementing issues that point at it.

## Resolved questions

- **Separate workflow, not states inside Product Direction.** Reusable from any issue or by hand; the direction integrates through blocking like every other tranche.
- **One child per variant, not one run building five.** Divergence needs separate contexts, a round should run in parallel, and each variant's history should be legible on its own issue.
- **Critique is a state, not a subagent.** A separate run is a fresh context by construction and can take a different tier; a subagent is harness-specific.
- **One "Next round" transition.** Two transitions between the same states are rejected, so riff and start-over are modes of one transition decided by the comment.
- **At most one revision per variant** (the user's call, 2026-09-07): enough to fix an execution miss, not enough to launder a weak direction; the human sees a scored gallery sooner.
- **Riff rounds keep only what was praised.** The first exploration (Tines/295) showed the original riff rule — "the winner's identity is fixed, vary one axis" — produces five near-copies. A riff round now turns the human's comment into a Keep list (exactly the things called out as good), round requirements (anything asked for), and Open (everything else); each child must change two or three major dimensions, at most one may be "the winner, evolved", and the critic caps direction fit at 5 for a variant that reads as the source with one dial turned.
- **Self-contained means at runtime, not at build time.** The craft base originally said "inline all CSS and JS, no external scripts", which builders read as "no libraries". It now says the page may reference nothing outside its folder, and that libraries are vendored into `vendor/`, images shipped as files in `img/`, fonts in `fonts/`, with a still fallback for WebGL and heavy motion.
- **The critic's bar is a knob, rounds are not.** `bar` lets a strong variant skip its revision; the round cap is a prompt constant until there is evidence more rounds help.
