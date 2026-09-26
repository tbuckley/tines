# tines

An orchestration layer for AI agents, allowing you to create an ecosystem of agents collaborating towards your goals.

The core of Tines is an issue tracker, which makes work legible to both humans and agents. It acts as a log of work, actions taken, and hand offs. Issues move between states according to workflows, finite state machines that define the allowed transitions and roles for each state.

Tines acts as a supervisor, assigning tasks to agents across managed services (using your own API keys) as well as local devices (using your own subscriptions). See [Running agents](#running-agents) for how that side works.

Operators can reconcile finalized run spend with the [period usage ledger](docs/usage.md).

## Repository layout

This is a pnpm workspace:

| Package | Path | What it is |
| --- | --- | --- |
| `@tines/web` | `apps/web` | SvelteKit (Svelte 5) app deployed to Cloudflare Workers. Serves the UI and the API (`/api/*`). Uses D1 for the database, [Better Auth](https://better-auth.com) for sign-in (Google OAuth and email magic links via [Cloudflare Email Service](https://developers.cloudflare.com/email-service/)), and [shadcn-svelte](https://shadcn-svelte.com) for UI components. |
| `tines` | `packages/cli` | The `tines` CLI, published to npm as [`tines`](https://www.npmjs.com/package/tines). Talks to the same API as the web app. |
| `@tines/shared` | `packages/shared` | Shared API types and client, used by both the web app and the CLI. |

Workflow packages and default-off immutable public snapshots are documented in
[docs/workflow-packages.md](docs/workflow-packages.md). Public launch remains disabled until the
separate moderation and operational-readiness review is accepted.

## Getting started

### Your first project (hosted)

Sign in to the [hosted app](https://tines.tbuckley.dev), open **Projects**, and choose
**New project**. Pick the starter that matches the work; the preview shows what it will
create, and the workflows, context, and issues it creates remain editable from
**Workflows**, **Context**, and the issue page.

**Code repository** needs a project name and a cloneable repository URL; the branch is
optional and defaults to the repository's default branch. Its editable **How we work**
conventions cover test commands, base and working branches, pull-request expectations, and
important paths. It creates or reuses the **Code change** workflow as the project default,
adds repository context and normally conventions, and opens **Find and fix a bug** in **In
progress**. Follow the Agents checklist (see [Running agents](#running-agents)) to connect and
route an agent. The agent should verify a real bug, fix and test it on a branch, open and
attach a `pr` artifact, then **Submit for review**; in **Review**, a human can **Approve** or
give feedback and **Send back**. **No bug found** is an honest route to Review with an
explanation, but it is not a successful bug-to-PR result. Approval records the Tines
workflow decision; it does not merge the GitHub pull request.

**Plan something together** needs a project name and a useful brief, but no repository. Its
editable conventions capture the people involved, dates and place, constraints, and what
the human will decide. It creates or reuses **Idea** as the default workflow, adds a
**Scout** workflow, conventions, and a project-owned `planning-guide` with the actual
workflow bindings, then opens **Scout candidates for …** in **Scouting**. The agent should
research worthwhile, sourced ideas (normally four to six), create each in **New**, attach a
Markdown `proposal`, and **Propose** it. A human can **Approve**, **Pass**, or give feedback
and **Send back**; **Reworking** must attach a new proposal version before **Re-propose**.
Fewer or no qualifying candidates is truthful, but does not demonstrate a successful
four-proposal result.

**Blank** creates an empty project with no starter-created workflow, repository, or first
issue. Its optional, non-developer **How work is done here** text becomes a conventions
prompt; leaving it empty creates no conventions prompt. System and user-created workflows
and other context can still be available, and you add the work and project context you
need.

CLI users can [install and sign in](#installing-the-cli-globally), discover the current
starters, and create the same projects (replace the example URL, branch, and brief with
your own):

```sh
tines projects starters
tines projects create "Website" --starter code --repo https://github.com/you/website.git --branch main
tines projects create "Family weekend" --starter plan --brief "A family weekend in Boston with two adults and children aged 4 and 7; indoor and outdoor options near our base, with time for lunch and rest."
tines projects create "Household plans" --starter blank --prompt "Keep proposals practical and explain costs and uncertainties."
tines projects create "Scratch space" --starter blank --no-prompt
```

Omit `--branch` to use the repository's default. Code and Plan use their rendered
conventions templates unless `--prompt "…"` (or `--prompt @conventions.md`) replaces only
the conventions, or `--no-prompt` omits only the conventions. Their workflow, repository
or planning guide, and first issue are still created. Clearing the browser's conventions
text has the same omit behavior. Blank—and CLI project creation without `--starter`—requires
an explicit `--prompt` or `--no-prompt`; do not combine Code or Plan with
`--default-workflow`, because each supplies its own default.

An identical workflow is reused rather than duplicated, so edits to that shared workflow
can affect other projects using it; changing only the conventions does not make a separate
workflow. Starter creation itself does not add routing rules or change automation settings.
Continue with the app's current **Agents** checklist and [Running agents](#running-agents);
the [runner daemon guide](docs/runner-daemon.md) explains how a local runner receives the
repository and starts its harness. A machine owner can opt into web-adjustable concurrency
with `--allow-remote-concurrency --max-concurrent N`; `N` remains a local ceiling that the
web cannot enable or raise.

### Shared projects (in review)

The Tines/669 branch adds invitations, safe member reads, attributed comments
and awaiting-human decisions, plus personal issue and recurring permission in
the browser. Only the owner's approved agents may run in this first release;
member permission can be saved but cannot launch work. API and run keys cannot
set personal permission. See [Shared projects](docs/shared-projects.md) and the
[proposed execution handoff](docs/shared-project-execution-contract.md). The
handoff remains unreviewed until the parent change lands and review completes.

### Contributor setup

Prereqs: Node 20+, pnpm 10 (`corepack enable`).

```sh
pnpm install

# one-time local setup
cd apps/web
cp .dev.vars.example .dev.vars           # works as-is; Google OAuth creds are optional
pnpm db:migrate:local                     # create the tables in local D1
pnpm db:seed:local                        # a dev user (dev@tines.local) and an API key

# run the app (from the repo root)
pnpm dev                                  # http://localhost:5173
```

To sign in, enter `dev@tines.local` (or any address) on the landing page. Nothing is
delivered locally: `pnpm dev` prints the magic link to its console — open it. Google
sign-in also works once the OAuth credentials are in `.dev.vars` (see below).

With the dev server running, try the CLI with the seeded key (the seed prints it):

```sh
export TINES_API_KEY=tines_dev0000000000000000000000000000000000000
pnpm cli time                             # dev mode (tsx, no build needed)
pnpm cli projects list
pnpm cli time --json                      # flags go straight on; `--` breaks pnpm 10

# or the built binary
pnpm build
node packages/cli/dist/index.js time --url http://localhost:5173
```

The CLI reads the API base URL from `--url` (accepted by every command that talks to the API), then the `TINES_API_URL` env var, then the file `tines login` writes (`~/.config/tines/config.json`); the default is the production deployment, `https://tines.tbuckley.dev`. The local-only `logout`, `runner restart`, `runner uninstall`, `runner workspaces`, and `runner workspaces prune` commands take no `--url`. The API key resolves the same way (`--api-key`, `TINES_API_KEY`, the file). For local development, `pnpm cli` **always** targets `http://localhost:5173` — its script pins `TINES_API_URL` rather than defaulting it, so a `TINES_API_URL` already in your environment (every agent run has one, pointing at production) is ignored and the snippet above talks to your dev server. To reach any other deployment from source, including a dev server vite moved to another port, pass `--url` (`pnpm cli time --url http://localhost:5174`) or use the installed `tines` / the built binary. `tines config` shows what is in effect and where each value came from.

Paginated `… list` commands return one page. Pass `--all-pages` to follow the cursor and fetch the whole list in one command, up to a default 10,000-item safety ceiling; use `--max-items <n>` with `--all-pages` to choose a different positive bound. Exceeding the bound fails without printing a partial result. Without `--all-pages`, `--json` output carries a `next_cursor` and warns on stderr that there is more. Five lists are not paginated and take no such flag: `labels list`, `runners list`, `routing list`, `api-keys list`, and `issues artifacts list` return the whole collection by design.

## Installing the CLI

```sh
npm install -g tines                      # puts the `tines` command on your PATH
tines --help
```

Every push to `main` publishes a new version (see "Publishing the CLI to npm" below), so a fresh `npm install -g tines` — or `npm install -g tines@latest` to upgrade — tracks this repo. Node 20+ is the only prerequisite.

Agents can skip the install entirely; `npx -y` needs no global install, PATH changes, or prior setup:

```sh
npx -y tines time --url https://tines.tbuckley.dev
```

Store an API key (Settings → API keys in the web app) once and every command is
authenticated. To point it at a local dev server or another deployment, store that URL too,
or set the env var in your shell profile:

```sh
tines login --api-key tines_…                    # or `--api-key -` to paste it on stdin
tines login --url http://localhost:5173          # a dev server; the default is the production URL
tines config                                     # what is in effect, and from where
tines logout                                     # forget both
export TINES_API_URL=http://localhost:5173       # the env-var alternative
```

`login` checks the key against the API before storing it. Env vars still win over the file
(`TINES_API_URL`, `TINES_API_KEY`), which is how agent runs are configured, and `--url` /
`--api-key` win over both.

## Developing the CLI

Day to day, run the CLI straight from the workspace with `pnpm cli <args>` (see "Getting started" above) — no build, no install.

To put an *unreleased* build on your PATH, install from a local clone. Installing straight from the repo URL (`npm install -g github:tbuckley/tines`) does **not** work — the repo is a pnpm workspace and the CLI lives in `packages/cli` — but the build bundles `@tines/shared` into `dist/index.js`, so the package folder is installable on its own:

```sh
git clone https://github.com/tbuckley/tines.git
cd tines
corepack enable                           # if pnpm isn't set up yet
pnpm install
pnpm build
npm install -g ./packages/cli
```

To pick up later changes: `git pull`, `pnpm install`, `pnpm build`, then re-run `npm install -g ./packages/cli`.

If you're actively hacking on the CLI, run `pnpm link --global` from `packages/cli` instead of `npm install -g` (requires a one-time `pnpm setup`). The global `tines` then symlinks into your clone, so every `pnpm build` is picked up without reinstalling.

Either way you are off the release train until you run `npm install -g tines@latest` again.

## Publishing the CLI to npm

Publishing lets anyone — including coding agents — install the CLI without cloning this repo. The package publishes as the bare name **`tines`**. The tarball's application payload is only `dist` (see `files` in `packages/cli/package.json`; npm also includes the package metadata and README), `prepublishOnly` rebuilds before every publish, and the build bundles everything — `@tines/shared` and `commander` alike — so the package has **no runtime dependencies**.

Consumers install it with `npm install -g tines`, or run it with no install at all via `npx -y tines` — see "Installing the CLI" above.

### Releases are automatic

**Every push to `main` publishes a new version** (`.github/workflows/publish-cli.yml`). Nothing is tagged, gated on a changelog, or released by hand. That is deliberate: the CLI and the API in `apps/web` deploy from the same commits, and an installed CLI that lags the API is a silent trap — agents follow instructions naming subcommands their binary does not have (Tines/42).

Versions are `<major>.<minor>.<commit-count-on-main>`:

- **`<major>.<minor>`** is whatever `packages/cli/package.json` says. Bump it in a normal PR when you want to start a new line.
- **The patch** is `git rev-list --count HEAD`, stamped into the manifest by CI just before publishing. It is monotonic and unique per merge, and it needs no bump commit pushed back to `main` — which the `main-protect` ruleset forbids anyway (PR-only, no bypass actors).

So the version committed in `packages/cli/package.json` is a *base*, not the released number, and will not match npm. `tines --version` reads the manifest at runtime, so an installed CLI always reports the version it was actually published as — that is the number to quote when diagnosing drift.

The workflow no-ops if the computed version is already on npm, so re-runs and `workflow_dispatch` are safe. It does not pass `--provenance`: npm attestations require a public source repository and this one is private.

Local builds (`npm install -g ./packages/cli`) report the base version from the manifest, so a `tines --version` far below `npm view tines version` means you are on a local build, not a stale install.

#### One-time setup

The workflow authenticates by [trusted publishing](https://docs.npmjs.com/trusted-publishers/) (OIDC) — there is no npm token stored anywhere, nothing to rotate, and nothing that can expire and quietly break the publish. On <https://www.npmjs.com/package/tines/access>, add a trusted publisher of type GitHub Actions:

- **Organization or user:** `tbuckley`
- **Repository:** `tines`
- **Workflow filename:** `publish-cli.yml`
- **Environment:** leave blank

That is the whole setup. npmjs then trusts publishes coming from that exact repo + workflow: GitHub mints a short-lived, workflow-scoped OIDC token per run (the workflow requests `id-token: write`), and npm swaps it for a one-shot publish credential. The exchange lives in the npm CLI and needs npm ≥ 11.5.1 — `pnpm publish` delegates the actual publish, auth included, to the npm on PATH, and Node 22's bundled npm 10 fails with `ENEEDAUTH` without ever attempting it — so the workflow upgrades npm on the runner first. Until the publisher is configured, the publish step fails with an auth error; everything before it still passes. Constraints to know about: GitHub-hosted runners only, and because this repository is private you get no provenance attestations (the workflow pins provenance off).

To publish by hand in a pinch: `cd packages/cli && npm login && pnpm publish --no-git-checks` after setting the version yourself. Prefer merging to `main`.

## Projects

Projects are the top-level container for issues. A project you are done with is **archived**
rather than deleted: archiving hides it from the lists and pickers that feed new work, pauses
its scheduled tasks, stops agents dispatching on it and makes its issues read-only — while every
link, ref, artifact and URL keeps resolving. It is reversible at any time.

```sh
tines projects archive "Paris 2026"      # pauses schedules, stops dispatch, issues read-only
tines projects unarchive "Paris 2026"    # schedules resume from their next occurrence
tines projects list --archived           # include archived projects (hidden by default)
```

An issue can also be **moved to another project** without losing anything. The issue keeps its
stable ID, its comments, artifacts and versions, labels, links, runs, workflow state, pins,
attempts and its schedule; it gets the destination's next never-used number, and every address
it has ever answered to keeps resolving — for reads, for authorized writes, and for old browser
URLs, which redirect to the current canonical one.

```sh
tines issues transfer Tines/392 --project Platform --dry-run   # review; writes nothing
tines issues transfer Tines/392 --project Platform             # review, then confirm
```

Things worth knowing about a move:

- The review is the point: it exposes guidance the issue loses, gains and retains; the effective
  repository winner and overridden candidates with scope, URL, branch and checkout directory;
  retained pins; checkout conflicts; and routing before and after. Missing routes, rule ties,
  unavailable runners and checkout conflicts are disclosed, not vetoes.
- A preview allocates nothing. The destination number is assigned by the confirmed move, so a
  cancelled review consumes no number and emits no event.
- A move is refused while a run is assigned, launching or running on the issue, and while
  either project is archived. Nothing is drained or cancelled on your behalf.
- Only a human session or an ordinary named key may move an issue. A run key may read the
  review — that is how an agent argues for a move — but never commits one.
- A project that owns an issue's old address cannot be deleted, even with `--force-context`;
  archive it instead. Its old refs must keep working.
- Activity keeps its history honest: the source project's feed retains the events recorded
  there, the destination's feed picks up the move and everything after it, and the issue's own
  feed stays complete.
- `tines issues move` is unrelated: that is a workflow transition.

Things worth knowing:

- `projects list --archived` **includes** archived projects; it does not filter to them.
- `issues list`, `schedules list` and `context list` have no `--archived` flag. Their default
  omits an archived project's rows unless you name the project (`--project`), or, for context,
  name the issue (`--issue`) — naming an anchor overrides the default. At the HTTP level the
  same lists take `?archived=true|false|all`.
- A write against an archived project fails with `422 project_archived`, whose message quotes
  the command that undoes it (`details.unarchive_command` carries it verbatim).
- Archiving **drains**: runs already under way finish on their own issue, and stay cancellable.
  Unarchiving re-arms enabled schedules at their next future occurrence rather than replaying
  missed ones.
- In the browser, `/projects` hides archived projects behind a "Show archived (n)" toggle, and
  an archived project's pages carry a read-only banner with an Unarchive action.
- The browser's project control is a sticky, per-user focus for Issues, Context, Activity,
	Workflows, and the Agents presentation. It also links to the focused project, the remembered
	projects grid, and the existing new-project flow. Primary navigation contains Issues, Workflows,
	and Agents; Context and Activity remain complete pages linked from relevant detail surfaces.
	Cross-project issue links preserve the current focus and offer an explicit focus action instead.
- Focus is presentation only: API lists, CLI commands, launch prompts, runners, fleet queue,
  quotas, and automation controls remain workspace-wide unless explicitly scoped.

The rules are recorded in [`specs/projects/SPEC.md`](specs/projects/SPEC.md).

## Running agents

Behind the issue tracker sits a supervisor: it decides which issues agents should take on,
launches them, streams their output back as a run log, and records what each attempt cost.
Automation is **on by default**. Eligible work can start as soon as an available runner and
an explicit matching routing rule exist. The kill switch remains an intentional stop/resume
control; an account that has saved automation off stays stopped until explicitly resumed.

An issue is eligible for an agent exactly when its state's category is `active` (states in
`backlog`, `awaiting_human`, and `done` are never touched), it is unblocked, it has no run
already in flight, and some routing rule matches it. `tines issues dispatch <ref>` explains
the verdict for any issue, runner by runner.

### Runners

A **runner** is one launch target you own. Two types ship today:

| Type | What it is | Created by |
| --- | --- | --- |
| `claude_managed` | Sessions in Anthropic's managed sandbox, billed to your own Anthropic API key. | Adding the key on the **Agents** tab. |
| `local` | A daemon on one of your own machines driving a harness — Claude Code (`claude -p`), codex (`codex exec`), or a custom command template — on that machine's subscription and git credentials. | The daemon registering itself on first start. |

#### Your first agent run

Install → key → runner → rule → observe. Automation needs no separate arming step:

1. **Install** the CLI on the machine that will do the work: `npm install -g tines`.
2. **Key** — Settings → API keys, or **Create key** inside the Agents tab's *Add runner →
   Local* dialog, which fills it into the command below for you.
3. **Runner** — install the daemon as a service, naming it machine-plus-harness:

   Using Codex? Set workspace-write and enable outbound network access before starting the
   runner, then use `--harness codex`. Follow the
   [Codex permissions setup](docs/runner-daemon.md#codex-permissions); the
   [OpenAI configuration reference](https://developers.openai.com/codex/config-reference)
   defines these settings.

   ```sh
   TINES_API_KEY=tines_… tines runner install \
     --url https://tines.tbuckley.dev \
     --name macbook-claude \
     --harness claude-code
   ```

   One command registers the runner, stores its token, and loads the daemon under
   launchd/systemd, where it survives reboots and restarts itself onto each new release.
   `macbook-claude` is what every agent comment will say ("you via macbook-claude") and what
   routing rules address. It appears on the Agents tab, online, within seconds.
4. **Rule** — a runner takes no work until something routes to it: click **Route everything
   to macbook-claude** in the dialog, or `tines routing set macbook-claude`.
5. **Observe** — eligible work starts when the runner is available and routing matches.
   Descriptions and repository context are useful but optional. If you previously stopped
   automation, resume it on Agents or with `tines supervisor enable`.

Self-hosters swap the `--url` for their own deployment; local runners are why self-hosting
Tines usually means running something on a machine of your own.

The daemon polls for work assigned to it, materializes a per-run workspace (the launch
prompt, the issue's skills, and clones of its repos), runs the harness there, and reports
the finish. It also keeps its own copy of the `tines` CLI current from npm and puts that on
the harness's PATH, so agents run the CLI that matches the prompt they were given rather
than whatever was last installed on the machine — a daemon left running across an upgrade
keeps whatever behaviour it started with, so restart it after upgrading. **[docs/runner-daemon.md](docs/runner-daemon.md)**
covers registration, the flags, token rotation, the managed CLI, failure behaviour, and
the service `tines runner install` sets up.

Managed runners hold an Anthropic API key encrypted at rest with `SECRET_ENCRYPTION_KEY`
(a Workers secret — see Deploying below); it is write-only after saving. They clone repos
through the provider's git proxy using one GitHub PAT stored in supervisor settings, so
scope that PAT to exactly the repos your context items point at — it is the blast radius of
any run. Local runners ignore it and use the device's own git credentials.

A `gemini_managed` type exists in the schema but has no adapter yet; the registry in
`apps/web/src/lib/server/supervisor/adapter.ts` is the source of truth for what can
actually launch.

### What a run can change

Every run gets a key minted for it, bound to its issue and that issue's project and revoked
when the run ends. By default the key writes only to its own issue: it can comment, attach
artifacts, label, link, write that issue's context and its stage journal, and take the
issue's transitions. It can read the rest of its project and create issues there, with
existing labels and links. An issue a run files counts as its own for the rest of that run,
so it can go on commenting on, labelling, editing and moving it.

Some stages exist to act on other work: backlog triage, journal upkeep, applying approved
prompt changes. For those, the workflow owner widens the stage on its workflow page, under
**What runs can change**:

- **Its own issue** (default) — as above.
- **Any issue in its project** — also comment on, transition, edit, label and link every
  issue in the run's project, and rewrite any of that project's journals.
- **Project, plus shared context, workflows and labels** — also create and edit prompt and
  skill items that are not scoped to another project, workflows, and labels.

Only the owner sets this, from a browser session; no API key can, so a run can never widen
its own stage. At every level a run cannot delete workflows or labels, write env
items, change runners, routing, the supervisor or API keys, force-set a state, put an issue
into a stage whose scope reaches further than its own, or apply a label a routing rule
matches. Only the widest level can create new labels.

### Routing, quotas, and budgets

All of this is edited on the **Agents** tab, and most of it from the CLI too:

- **The kill switch** — `tines supervisor enable` (resume) / `tines supervisor disable`, with
  `tines supervisor status` for a one-screen overview — which now also lists the issues
  waiting for an agent, grouped by why, with the fix for each.
- **Stage flow** — the Agents tab and `tines supervisor stats --window 7d` compare queue wait,
  work time, runs per visit, outcomes and sent-back rates with the prior window. Project and
  event-window filters keep the board and `tines events list` on the same slice.
- **Routing rules** decide who takes an issue. A rule is scoped globally, per project, per
  workflow state, or both (most specific wins), and its payload is an ordered
  preference list of `<runner>[:tier]` targets:
  `tines routing set claude:cheapest macbook-claude --state "Docs Change/Writing"`. An issue no rule
  matches never dispatches — automation is opt-in. A single issue can override routing with
  a pin: `tines issues assign <ref> <runner>[:tier]`. A scoped singleton such as
  `tines routing set --state "Docs Change/Writing" '*:smartest'` inherits the next
  lower-priority rule's ordered runners while overriding every entry to that tier.
- **Tiers** — rules say `smartest`, `balanced`, or `cheapest` rather than naming model ids
  that go stale; per-runner overrides live in `tines runners tiers <name>`.
- **Quota policy** — one per user: a global concurrency cap
  (`tines supervisor quota global 3`) or a per-state roster
  (`tines supervisor quota roster --default 1 --state "Docs Change/Review=3"`). Each
  runner's own `max_concurrent` always applies on top of it.
- **Budgets** — `tines runners budget <name>`. The per-run caps enforce today:
  `--max-run-usd` becomes the platform-enforced session budget on Claude runners,
  `--max-run-tokens` is checked as the sweep polls usage, and each runner's
  `max_run_minutes` (default 30) is the universal backstop. `--daily-usd` and
  `--daily-tokens` are accepted and stored, but daily budgets are **not yet enforced**.

Runs are listed with `tines runs list` (`--active` for the ones holding a claim) and read
with `tines runs show <id>`. A failed run strikes its issue; after the attempt limit the
issue is parked with a needs-attention flag until a human runs `tines issues resume <ref>`. Runs
the pipe ended rather than the agent — the runner went offline, the daemon restarted or
shut down — are recorded as `interrupted` and cost the issue nothing; the runner that
keeps dropping them backs off instead.

### The sweep and its cadence

Agent dispatch and **scheduled tasks** — recurring issue templates, created with
`tines issues create <project> --title … --every daily` and managed with `tines schedules`
— share one clock. One Cloudflare Cron Trigger drives everything time-based —
`"triggers": { "crons": ["*/5 * * * *"] }` in `apps/web/wrangler.jsonc`. Each firing runs
`apps/web/worker/index.ts`, which sweeps scheduled tasks first (creating issues whose
recurrence is due) and then the supervisor (dispatching eligible issues, polling managed
runs for status and usage, timing out overdue runs, failing runs whose local daemon has
gone offline) — in that order, so an issue a schedule creates can be dispatched by the same
firing.

Five minutes is the backstop, not the latency: eligibility-changing writes — a transition,
an unblock, a daemon poll freeing capacity, a settings edit — queue an opportunistic
dispatch pass immediately, and the sweep exists to make those passes optional rather than
load-bearing.

The cadence does have one user-visible consequence. **An occurrence fires at the first
sweep at or after its nominal time**, so an issue from a schedule set for 09:00 can carry a
creation timestamp up to five minutes later. Schedules are guardrailed to fire no more
often than hourly, so the lag stays small relative to the recurrence.

Locally, `pnpm preview` (from `apps/web`) builds and runs the worker under `wrangler dev
--test-scheduled`, which exposes `GET /__scheduled` to fire a sweep on demand instead of
waiting for the clock; `pnpm dev` (Vite) never runs the `scheduled()` handler. The script
also passes `--host localhost:8787`: `wrangler dev` otherwise presents every request to the
worker under the production custom domain from `routes`, and Better Auth then ignores the
sign-in routes.

### Artifacts and transition gates

An issue also carries **artifacts** — named, typed, versioned work products attached along
the way: a `file` (bytes in R2), a `text` document, a `link`, a `pr` reference, or a
`folder` (a multi-file tree uploaded as one immutable snapshot). Attaching to a name that
already exists appends the next version; nothing is overwritten.

```sh
tines issues artifacts attach <ref> design-doc design.md    # positional: the gate types it
tines issues artifacts attach <ref> screenshots ./shots
tines issues artifacts list <ref>
tines issues artifacts get <ref> design-doc --out .
```

Prefer that positional form — it is what a gated slot's own hint prints, and it lets the
gate decide how to read the path (a `text` gate reads the file as the document, a `file`
gate uploads its bytes, a `folder` gate walks the directory). Explicit `--file` / `--text` /
`--folder` / `--link` / `--pr` flags override the gate, and are refused before any write
when no transition could ever accept what they would create.

Artifacts are what **transition requirements** gate on: a workflow transition can demand a
*fresh* artifact of a given name (optionally type and content type) before it can be taken.
Fresh means the version was attached at or after the issue last entered its current state,
so bouncing an issue back to an earlier state invalidates the old attachment with no
mutation machinery — `tines issues artifacts reaffirm <ref> <name>` blesses unchanged
content as current without re-uploading it. A blocked `tines issues move` returns the unmet
requirements and the attach command to fix them. Agents can satisfy their own gates (run
keys may attach and reaffirm) but cannot route around one: the forced state-set on an issue
is human-only.

Artifacts are never stitched into a prompt or seeded into a workspace — the launch prompt
lists them with a fetch command and the agent pulls what it needs. Caps: 25 MB per file,
256 KB per text artifact, 50 versions per artifact, and 200 files / 50 MB per folder
snapshot. The design is in [specs/artifacts/SPEC.md](specs/artifacts/SPEC.md).

## Google sign-in

1. Create an OAuth 2.0 Client ID at <https://console.cloud.google.com/apis/credentials>.
2. Add `http://localhost:5173/api/auth/callback/google` (and your production equivalent) as an authorized redirect URI.
3. Put the client ID/secret in `apps/web/.dev.vars` locally; in production, set them with `wrangler secret put GOOGLE_CLIENT_ID` etc.

Better Auth is mounted at `/api/auth/*` (see `apps/web/src/hooks.server.ts`); its D1 schema lives in `apps/web/migrations/`.

## Magic-link sign-in

Email sign-in links are sent with [Cloudflare Email Service](https://developers.cloudflare.com/email-service/) (beta, requires the Workers Paid plan) through the `EMAIL` send binding in `apps/web/wrangler.jsonc`.

Local dev needs no setup: the binding is simulated and nothing is delivered. `pnpm dev` prints each sign-in link to its console; `wrangler dev` (and `pnpm preview`) instead log the message's file paths under `.wrangler/tmp/email/`, and the link is in the `.txt` one.

To send real emails in production:

1. Onboard a domain you manage with Cloudflare DNS: dash → **Compute → Email Service → Email Sending → Onboard Domain**. Cloudflare adds the SPF/DKIM/DMARC and bounce DNS records automatically.
2. Set `EMAIL_FROM` in `wrangler.jsonc` `"vars"` to an address on that domain (e.g. `login@yourdomain.com`) — the mailbox doesn't need to exist.
3. Deploy. To send real emails from `wrangler dev` too, add `"remote": true` to the `EMAIL` binding.

## Adding UI components

shadcn-svelte is configured in `apps/web` (`components.json`, Tailwind v4 theme in `src/app.css`):

```sh
cd apps/web
pnpm dlx shadcn-svelte@latest add card
```

## Deploying to Cloudflare

Production is served at <https://tines.tbuckley.dev> via a Workers custom
domain (`routes` in `apps/web/wrangler.jsonc`); the tbuckley.dev zone must be
on the same Cloudflare account, and the first deploy creates the DNS record
and certificate automatically. `workers_dev` is on so its hostname can become
the **artifact sandbox origin**, the cross-site host that executes HTML artifacts.
The hostname serves only artifacts once `ARTIFACT_SANDBOX_ORIGIN` is configured. `workers.dev` is
on the Public Suffix List, so a page there is a different registrable domain
from `tines.tbuckley.dev` and carries none of the app's cookies;
`hooks.server.ts` serves nothing but `/s/*` on that host. To turn it on, set
`vars.ARTIFACT_SANDBOX_ORIGIN` in `apps/web/wrangler.jsonc` to
`https://tines-web.<subdomain>.workers.dev` — `<subdomain>` is the account's
workers.dev subdomain, which any preview URL (below) spells out. The value must
be an HTTP(S) origin without credentials, a path, query, or fragment; a trailing
slash, host capitalization, and default port are normalized. Invalid values
fall back to same-origin sandboxing. Before enabling it, smoke-test the real
host: `/issues` and `/api/v1/projects` must return 404, while a minted `/s/…/`
link must run in the viewer with storage available and API access blocked.
Leaving the
var unset is supported and is what local dev, e2e and PR previews do: sites
are then served from the app origin under CSP `sandbox`, which is equally
locked down but gives the page an opaque origin, so `localStorage` throws.
See `specs/artifacts/SPEC.md` "Sites: HTML artifacts". Per-version preview
URLs (below) are unaffected either way.

One-time setup (needs `wrangler login` or a `CLOUDFLARE_API_TOKEN` in the environment):

```sh
cd apps/web
pnpm wrangler d1 create tines             # then paste the database_id into wrangler.jsonc
pnpm db:migrate:remote
pnpm wrangler r2 bucket create tines-artifacts   # the ARTIFACTS and RUN_LOGS bindings in
pnpm wrangler r2 bucket create tines-run-logs    # wrangler.jsonc; without them the worker
                                                 # silently stores no artifacts or run logs
pnpm wrangler secret put BETTER_AUTH_SECRET
pnpm wrangler secret put GOOGLE_CLIENT_ID
pnpm wrangler secret put GOOGLE_CLIENT_SECRET
pnpm wrangler secret put SECRET_ENCRYPTION_KEY   # `openssl rand -hex 32`; encrypts
                                                 # stored provider keys and the GitHub
                                                 # PAT at rest (see "Running agents")
# confirm EMAIL_FROM in wrangler.jsonc "vars" is on a domain onboarded to
# Email Service (see "Magic-link sign-in" above)
pnpm deploy:prod                                 # `deploy` alone is a pnpm builtin,
                                                 # which is why the script is suffixed
```

After that, deploys are automatic (below); `pnpm deploy:prod` from `apps/web` is
there for the rare manual one. It is not called `deploy` because `pnpm deploy` is a
pnpm builtin — builtins win over scripts, so that name is unreachable in the form
everyone types; `pnpm check` fails on any script named after a pnpm command (bar
`start`, `test`, `restart` and `install`, which pnpm does run as scripts).

### Continuous integration

`.github/workflows/ci.yml` runs on every pull request and push to `main`: one job
typechecks (`pnpm check`) and runs the unit tests, and three more each install Chromium's
headless shell and run one shard of the Playwright suite (`pnpm test:e2e --shard=N/3`)
against their own local `wrangler dev` with a throwaway D1. A final "Playwright e2e" job
just reports whether every shard passed, so the check name predates the sharding. It needs
no secrets, so it runs for fork PRs too. The deploy and publish workflows below run
unit tests again before shipping, but the e2e suite runs only here.

### Automatic deploys

`.github/workflows/deploy.yml` deploys on every push to `main` (and via manual
dispatch): it builds, runs unit tests, applies pending D1 migrations with
`wrangler d1 migrations apply tines --remote`, then runs `wrangler deploy`.
The workflow bakes the checkout's full Git SHA and the same deterministic version used by the CLI
publisher into the Worker before building. Inspect any running deployment without credentials:

```sh
curl -i https://tines.tbuckley.dev/api/version
```

The JSON body and the `X-Tines-Version` / `X-Tines-Commit` headers identify the server, not the
installed CLI making the request. Local `pnpm dev` and ordinary builds report `dev` plus local HEAD
(`unknown` only when Git metadata is unavailable). Packagers may explicitly provide the pair
`TINES_BUILD_VERSION` and `TINES_BUILD_COMMIT`; production additionally requires
`TINES_BUILD_CHANNEL=production` and a full-history checkout so the release number is reproducible.

To enable it, add two GitHub Actions secrets (repo → Settings → Secrets and
variables → Actions):

- `CLOUDFLARE_ACCOUNT_ID` — from the Cloudflare dashboard (Workers & Pages →
  right sidebar), or `pnpm wrangler whoami`.
- `CLOUDFLARE_API_TOKEN` — create at <https://dash.cloudflare.com/profile/api-tokens>
  with permissions **Account → Workers Scripts → Edit**, **Account → D1 → Edit**,
  and (for the custom domain) **Zone → Workers Routes → Edit** and
  **Zone → DNS → Edit** scoped to tbuckley.dev. Starting from the
  "Edit Cloudflare Workers" token template and adding D1 covers all of these.

Migrations run before the new worker version goes live, so keep them
backwards-compatible with the previously deployed code (add columns/tables
freely; do renames and drops in two releases, expand/contract style).
D1 tracks applied migrations in a `d1_migrations` table, so already-applied
files are skipped and a no-op run is safe. That ledger keys on the *filename*:
renaming an applied file makes D1 run it again under the new name, on
production and preview alike, so only rename migrations whose every statement
is `IF NOT EXISTS`.

### PR preview URLs

`.github/workflows/preview.yml` runs on every pull request (from branches in
this repo): it builds the web app, applies the PR's migrations to the
preview database, then uploads the worker with `wrangler versions upload
--env preview --preview-alias pr-<number>`. Nothing is promoted to live
traffic; the upload gets a stable per-PR alias URL like
`https://pr-<number>-tines-web-preview.<subdomain>.workers.dev` — the same
URL for every push to the PR, always serving the latest upload — which the
workflow posts (and keeps updated) as a PR comment. It uses the same two
Actions secrets as the deploy workflow.

Each preview reports `preview-pr-<number>-<sha12>` and the actual full commit that Actions built.
That commit can be GitHub's synthetic merge checkout rather than the PR head; the preview comment
names both values when they differ.

Previews use the `preview` wrangler environment (`env.preview` in
`apps/web/wrangler.jsonc`): a separate worker (`tines-web-preview`) bound to
its own D1 database (`tines-preview`), fully isolated from production data.
Magic-link sign-in works on previews — `BETTER_AUTH_URL` is unset there, so
auth derives its base URL from the request origin (preview URLs differ per
PR). Google OAuth does not work on previews (Google doesn't allow
wildcard redirect URIs). Scripts and agents can sign in to a preview as a
fixed test user with `POST /api/preview-login` once the preview worker has a
`PREVIEW_LOGIN_TOKEN` secret; see `docs/preview-login.md`.

One-time preview setup:

```sh
cd apps/web
pnpm wrangler d1 create tines-preview     # paste the database_id into env.preview in wrangler.jsonc
pnpm wrangler r2 bucket create tines-artifacts-preview   # env.preview's two buckets; bucket
pnpm wrangler r2 bucket create tines-run-logs-preview    # names are global, so no --env here
pnpm wrangler secret put BETTER_AUTH_SECRET --env preview
pnpm run build && pnpm wrangler deploy --env preview   # creates the preview worker once
```

All PRs share the one preview database, and each PR applies its own pending
migrations to it.

#### Recover an exactly renamed migration without resetting data

Deleting and recreating the preview database is still the right recovery for
disposable, genuinely divergent state, but it destroys all preview data. A
narrower recovery is possible when an applied migration was only renamed and
the old and new files are byte-for-byte identical. Do not use this procedure to
hide unknown or partial schema drift.

First, stop concurrent Preview migration runs. From the repository root, prove
the old and new revisions resolve to the same Git blob, then from `apps/web`
inspect the remote ledger, the full schema and data invariants established by
the migration, and the pending list. Continue only if the old filename occurs
exactly once, the new filename is absent, every expected schema object and
backfill is present, and `PRAGMA foreign_key_check` returns no rows. For the
`0026_issue_addresses.sql` to `0027_issue_addresses.sql` incident, for example:

```sh
git rev-parse <old-revision>:apps/web/migrations/0026_issue_addresses.sql \
  <new-revision>:apps/web/migrations/0027_issue_addresses.sql

cd apps/web
pnpm exec wrangler d1 execute tines-preview --remote --env preview --json \
  --command "SELECT id, name, applied_at FROM d1_migrations ORDER BY id"
pnpm exec wrangler d1 migrations list tines-preview --remote --env preview
```

Record a [Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/)
bookmark immediately before the repair. A secure full export is optional; it
briefly blocks requests and can contain sensitive preview data.

```sh
pnpm exec wrangler d1 time-travel info tines-preview --env preview --json
pnpm exec wrangler d1 execute tines-preview --remote --env preview --json \
  --command "UPDATE d1_migrations
    SET name = '0027_issue_addresses.sql'
    WHERE name = '0026_issue_addresses.sql'
      AND NOT EXISTS (
        SELECT 1 FROM d1_migrations
        WHERE name = '0027_issue_addresses.sql'
      )"
```

Require a successful result with exactly one changed row. Re-read the ledger
and confirm the new filename retained the old row's `id` and `applied_at`, then
repeat all schema, data, and foreign-key checks. The renamed migration must
disappear from `wrangler d1 migrations list`. Finally, run Preview from a
current same-repository PR and require both the migration step and preview
upload to succeed; confirm the pending list is empty afterward. If either
filename is duplicated or missing, the blobs differ, any schema/data check
fails, or the update changes anything other than one row, stop and investigate
instead of inserting a ledger row, rerunning the migration, or resetting the
database. See Cloudflare's [D1 migration
ledger](https://developers.cloudflare.com/d1/reference/migrations/) and [Time
Travel restore](https://developers.cloudflare.com/d1/reference/time-travel/)
documentation; a restore replaces the whole database and discards writes made
after the bookmark.

For a disposable preview database whose state genuinely diverged, delete and
recreate it:

```sh
pnpm wrangler d1 delete tines-preview
pnpm wrangler d1 create tines-preview     # paste the new database_id into env.preview
```

The next preview run re-applies all migrations from scratch.

## Scripts

From the repo root:

- `pnpm dev` — run the web app dev server (with local D1 bindings emulated)
- `pnpm build` — build the web app and CLI (`@tines/shared` has no build script; both
  consume it as TypeScript source)
- `pnpm check` — the migration-numbering and script-name guards in `scripts/` and `apps/web/scripts/`, then typecheck all packages (svelte-check + tsc)
- `pnpm test` — vitest unit tests (`ci.yml` runs them on every pull request, and the deploy and publish workflows run them again before shipping)
- `pnpm test:e2e` — Playwright e2e suite (boots the built worker under `wrangler dev` with a seeded local D1; see `apps/web/e2e/` and its README for the suite's motion, hydration and geometry policies). Run by `ci.yml` on pull requests, but not by `pnpm test`.
- `pnpm cli <command>` — run the CLI from source against the local dev server (`http://localhost:5173`, pinned; pass `--url` for anything else)

  Add exact-model reasoning effort by ordered target number: `tines routing set codex:balanced claude:balanced --project Example --effort 1=low --effort 2=medium`. Re-run the same targets without `--effort` to clear routed effort; `routing clear` deletes the whole scoped rule.
