# tines

An orchestration layer for AI agents, allowing you to create an ecosystem of agents collaborating towards your goals.

The core of Tines is an issue tracker, which makes work legible to both humans and agents. It acts as a log of work, actions taken, and hand offs. Issues move between states according to workflows, finite state machines that define the allowed transitions and roles for each state.

Tines acts as a supervisor, assigning tasks to agents across managed services (using your own API keys) as well as local devices (using your own subscriptions). See [Running agents](#running-agents) for how that side works.

## Repository layout

This is a pnpm workspace:

| Package | Path | What it is |
| --- | --- | --- |
| `@tines/web` | `apps/web` | SvelteKit (Svelte 5) app deployed to Cloudflare Workers. Serves the UI and the API (`/api/*`). Uses D1 for the database, [Better Auth](https://better-auth.com) for sign-in (Google OAuth and email magic links via [Cloudflare Email Service](https://developers.cloudflare.com/email-service/)), and [shadcn-svelte](https://shadcn-svelte.com) for UI components. |
| `tines` | `packages/cli` | The `tines` CLI, published to npm as [`tines`](https://www.npmjs.com/package/tines). Talks to the same API as the web app. |
| `@tines/shared` | `packages/shared` | Shared API types and client, used by both the web app and the CLI. |

## Getting started

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
pnpm cli time -- --json

# or the built binary
pnpm build
node packages/cli/dist/index.js time --url http://localhost:5173
```

The CLI reads the API base URL from `--url` (accepted by every command, without exception), then the `TINES_API_URL` env var, then the file `tines login` writes (`~/.config/tines/config.json`); the default is the production deployment, `https://tines.tbuckley.dev`. The API key resolves the same way (`--api-key`, `TINES_API_KEY`, the file). For local development, `pnpm cli` **always** targets `http://localhost:5173` — its script pins `TINES_API_URL` rather than defaulting it, so a `TINES_API_URL` already in your environment (every agent run has one, pointing at production) is ignored and the snippet above talks to your dev server. To reach any other deployment from source, including a dev server vite moved to another port, pass `--url` (`pnpm cli time --url http://localhost:5174`) or use the installed `tines` / the built binary. `tines config` shows what is in effect and where each value came from.

Every `… list` command returns one page. Pass `--all-pages` to follow the cursor and fetch the whole list in one command; without it, `--json` output carries a `next_cursor` and warns on stderr that there is more.

## Installing the CLI globally

Normally, install from npm — `npm install -g tines` — which is always current, because every push to `main` publishes a new version (see "Publishing the CLI to npm" below). The rest of this section is for running an unmerged branch.

Installing straight from the repo URL (`npm install -g github:tbuckley/tines`) does **not** work — the repo is a pnpm workspace and the CLI lives in `packages/cli` — so install from a local clone instead. The build bundles `@tines/shared` into `dist/index.js`, so the package folder is installable on its own:

```sh
git clone https://github.com/tbuckley/tines.git
cd tines
corepack enable                           # if pnpm isn't set up yet
pnpm install
pnpm build
npm install -g ./packages/cli
```

That puts `tines` on your PATH:

```sh
tines --help
tines time                                # https://tines.tbuckley.dev, the default
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

To upgrade later: `git pull`, `pnpm install`, `pnpm build`, then re-run `npm install -g ./packages/cli`. To go back to a released build, `npm install -g tines@latest`.

If you're actively hacking on the CLI, run `pnpm link --global` from `packages/cli` instead of `npm install -g` (requires a one-time `pnpm setup`). The global `tines` then symlinks into your clone, so every `pnpm build` is picked up without reinstalling.

## Publishing the CLI to npm

Publishing lets anyone — including coding agents — install the CLI without cloning this repo. The package publishes as the bare name **`tines`**. The tarball ships only `dist` (see `files` in `packages/cli/package.json`), `prepublishOnly` rebuilds before every publish, and the build bundles everything — `@tines/shared` and `commander` alike — so the package has **no runtime dependencies**.

Once published, anyone can install or run it:

```sh
npm install -g tines                      # installs the `tines` command globally
npx -y tines time                         # one-shot, no install — handy for agents
```

The `npx -y` form is the most agent-friendly: it needs no global install, PATH changes, or prior setup — just Node 20+.

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

The rules are recorded in [`specs/projects/SPEC.md`](specs/projects/SPEC.md).

## Running agents

Behind the issue tracker sits a supervisor: it decides which issues agents should take on,
launches them, streams their output back as a run log, and records what each attempt cost.
Nothing runs until you arm it — the automation kill switch is **off for a new user**, so
adding a runner or a routing rule is safe on its own.

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

Install → key → runner → rule → arm. Five steps, one terminal command and one click:

1. **Install** the CLI on the machine that will do the work: `npm install -g tines`.
2. **Key** — Settings → API keys, or **Create key** inside the Agents tab's *Add runner →
   Local* dialog, which fills it into the command below for you.
3. **Runner** — start the daemon, naming it machine-plus-harness:

   ```sh
   TINES_API_KEY=tines_… tines runner daemon \
     --url https://tines.tbuckley.dev \
     --name macbook-claude \
     --harness claude-code
   ```

   `macbook-claude` is what every agent comment will say ("you via macbook-claude") and what
   routing rules address. It appears on the Agents tab, online, within seconds.
4. **Rule** — a runner takes no work until something routes to it: click **Route everything
   to macbook-claude** in the dialog, or `tines routing set macbook-claude`.
5. **Arm** — flip the automation switch on the Agents tab (`tines supervisor enable`).
   It is off for new accounts, so nothing dispatches until you turn it on.

Self-hosters swap the `--url` for their own deployment; local runners are why self-hosting
Tines usually means running something on a machine of your own.

The daemon polls for work assigned to it, materializes a per-run workspace (the launch
prompt, the issue's skills, and clones of its repos), runs the harness there, and reports
the finish. It also keeps its own copy of the `tines` CLI current from npm and puts that on
the harness's PATH, so agents run the CLI that matches the prompt they were given rather
than whatever was last installed on the machine. **[docs/runner-daemon.md](docs/runner-daemon.md)**
covers registration, the flags, token rotation, the managed CLI, failure behaviour, and
launchd/systemd units for keeping it running.

Managed runners hold an Anthropic API key encrypted at rest with `SECRET_ENCRYPTION_KEY`
(a Workers secret — see Deploying below); it is write-only after saving. They clone repos
through the provider's git proxy using one GitHub PAT stored in supervisor settings, so
scope that PAT to exactly the repos your context items point at — it is the blast radius of
any run. Local runners ignore it and use the device's own git credentials.

A `gemini_managed` type exists in the schema but has no adapter yet; the registry in
`apps/web/src/lib/server/supervisor/adapter.ts` is the source of truth for what can
actually launch.

### Routing, quotas, and budgets

All of this is edited on the **Agents** tab, and most of it from the CLI too:

- **The kill switch** — `tines supervisor enable` / `tines supervisor disable`, with
  `tines supervisor status` for a one-screen overview — which now also lists the issues
  waiting for an agent, grouped by why, with the fix for each.
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

Previews use the `preview` wrangler environment (`env.preview` in
`apps/web/wrangler.jsonc`): a separate worker (`tines-web-preview`) bound to
its own D1 database (`tines-preview`), fully isolated from production data.
Magic-link sign-in works on previews — `BETTER_AUTH_URL` is unset there, so
auth derives its base URL from the request origin (preview URLs differ per
PR). Google OAuth does not work on previews (Google doesn't allow
wildcard redirect URIs).

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
migrations to it. If PRs with conflicting migrations leave it in a bad state,
throw it away and start over — it holds nothing precious:

```sh
pnpm wrangler d1 delete tines-preview
pnpm wrangler d1 create tines-preview     # paste the new database_id into env.preview
```

The next preview run re-applies all migrations from scratch.

## Scripts

From the repo root:

- `pnpm dev` — run the web app dev server (with local D1 bindings emulated)
- `pnpm build` — build all packages
- `pnpm check` — the migration-numbering and script-name guards in `scripts/` and `apps/web/scripts/`, then typecheck all packages (svelte-check + tsc)
- `pnpm test` — vitest unit tests (`ci.yml` runs them on every pull request, and the deploy and publish workflows run them again before shipping)
- `pnpm test:e2e` — Playwright e2e suite (boots the built worker under `wrangler dev` with a seeded local D1; see `apps/web/e2e/` and its README for the suite's motion, hydration and geometry policies). Run by `ci.yml` on pull requests, but not by `pnpm test`.
- `pnpm cli <command>` — run the CLI from source against the local dev server (`http://localhost:5173`, pinned; pass `--url` for anything else)
