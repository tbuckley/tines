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
cp .dev.vars.example .dev.vars           # fill in Google OAuth creds to test sign-in
pnpm db:migrate:local                     # create the Better Auth tables in local D1

# run the app (from the repo root)
pnpm dev                                  # http://localhost:5173
```

With the dev server running, try the CLI:

```sh
pnpm cli time                             # dev mode (tsx, no build needed)
pnpm cli time -- --json

# or the built binary
pnpm build
node packages/cli/dist/index.js time --url http://localhost:5173
```

The CLI reads the API base URL from `--url` or the `TINES_API_URL` env var (default `http://localhost:5173`).

## Installing the CLI globally (from GitHub)

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
tines time --url https://tines.tbuckley.dev
```

To make it target your deployment by default, set the env var in your shell profile (otherwise it talks to `http://localhost:5173`):

```sh
export TINES_API_URL=https://tines.tbuckley.dev
```

To upgrade later: `git pull`, `pnpm install`, `pnpm build`, then re-run `npm install -g ./packages/cli`.

If you're actively hacking on the CLI, run `pnpm link --global` from `packages/cli` instead of `npm install -g` (requires a one-time `pnpm setup`). The global `tines` then symlinks into your clone, so every `pnpm build` is picked up without reinstalling.

## Publishing the CLI to npm

Publishing lets anyone — including coding agents — install the CLI without cloning this repo. The package publishes as the bare name **`tines`** (unclaimed on npm as of August 2026; the first publish claims it). It's publish-ready: the tarball ships only `dist` (see `files` in `packages/cli/package.json`), `prepublishOnly` rebuilds before every publish, and since `@tines/shared` is bundled at build time the only runtime dependency is `commander`.

For each release:

```sh
cd packages/cli
npm login                                 # once per machine
npm version patch                         # or minor / major — npm rejects re-publishing an existing version
pnpm publish
```

Publish from a clean checkout of `main` (pnpm's git checks enforce this; `--no-git-checks` overrides in a pinch). If the first publish is rejected with a 403 despite the name being free, npm's name rules are blocking a too-similar name — fall back to a scoped name like `@tbuckley/tines` (add `--access public`, which scoped first publishes require); the installed command is named by the `bin` field, so it stays `tines` regardless of the package name.

Once published, anyone can install or run it:

```sh
npm install -g tines                      # installs the `tines` command globally
npx -y tines time                         # one-shot, no install — handy for agents
```

The `npx -y` form is the most agent-friendly: it needs no global install, PATH changes, or prior setup — just Node 20+. To automate releases, add a GitHub Actions workflow that runs `pnpm publish` on version tags with an npm [granular access token](https://docs.npmjs.com/about-access-tokens) stored as an `NPM_TOKEN` repo secret.

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

Local runners are why self-hosting Tines usually means running something on a machine of
your own:

```sh
TINES_API_KEY=<your API key> TINES_API_URL=https://your-tines.example \
  tines runner daemon --name laptop --harness claude-code
```

The daemon polls for work assigned to it, materializes a per-run workspace (the launch
prompt, the issue's skills, and clones of its repos), runs the harness there, and reports
the finish. No inbound connection to the machine is ever needed. **[docs/runner-daemon.md](docs/runner-daemon.md)**
covers registration, the flags, token rotation, failure behaviour, and launchd/systemd
units for keeping it running.

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
  `tines supervisor status` for a one-screen overview.
- **Routing rules** decide who takes an issue. A rule is scoped globally, per project, per
  workflow state, or both (most specific wins, no merging), and its payload is an ordered
  preference list of `<runner>[:tier]` targets:
  `tines routing set claude:cheapest laptop --state "Docs Change/Writing"`. An issue no rule
  matches never dispatches — automation is opt-in. A single issue can override routing with
  a pin: `tines issues assign <ref> <runner>[:tier]`.
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
issue is parked with a needs-attention flag until a human runs `tines issues resume <ref>`.

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

Locally, `wrangler dev --test-scheduled` exposes `GET /__scheduled` to fire a sweep on
demand instead of waiting for the clock.

## Google sign-in

1. Create an OAuth 2.0 Client ID at <https://console.cloud.google.com/apis/credentials>.
2. Add `http://localhost:5173/api/auth/callback/google` (and your production equivalent) as an authorized redirect URI.
3. Put the client ID/secret in `apps/web/.dev.vars` locally; in production, set them with `wrangler secret put GOOGLE_CLIENT_ID` etc.

Better Auth is mounted at `/api/auth/*` (see `apps/web/src/hooks.server.ts`); its D1 schema lives in `apps/web/migrations/`.

## Magic-link sign-in

Email sign-in links are sent with [Cloudflare Email Service](https://developers.cloudflare.com/email-service/) (beta, requires the Workers Paid plan) through the `EMAIL` send binding in `apps/web/wrangler.jsonc`.

Local dev needs no setup: `wrangler dev` simulates the binding, logging each email (including the sign-in link) to the dev server console instead of delivering it.

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
and certificate automatically. `workers_dev` is off, so the workers.dev
subdomain serves no production traffic — it's only used for per-version
preview URLs (below).

One-time setup (needs `wrangler login` or a `CLOUDFLARE_API_TOKEN` in the environment):

```sh
cd apps/web
pnpm wrangler d1 create tines             # then paste the database_id into wrangler.jsonc
pnpm db:migrate:remote
pnpm wrangler secret put BETTER_AUTH_SECRET
pnpm wrangler secret put GOOGLE_CLIENT_ID
pnpm wrangler secret put GOOGLE_CLIENT_SECRET
pnpm wrangler secret put SECRET_ENCRYPTION_KEY   # `openssl rand -hex 32`; encrypts
                                                 # stored provider keys and the GitHub
                                                 # PAT at rest (see "Running agents")
# confirm EMAIL_FROM in wrangler.jsonc "vars" is on a domain onboarded to
# Email Service (see "Magic-link sign-in" above)
pnpm deploy
```

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
files are skipped and a no-op run is safe.

### PR preview URLs

`.github/workflows/preview.yml` runs on every pull request (from branches in
this repo): it builds, runs unit tests, applies the PR's migrations to the
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
- `pnpm check` — typecheck all packages (svelte-check + tsc)
- `pnpm cli <command>` — run the CLI in dev mode
