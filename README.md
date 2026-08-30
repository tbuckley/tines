# tines

An orchestration layer for AI agents, allowing you to create an ecosystem of agents collaborating towards your goals.

The core of Tines is an issue tracker, which makes work legible to both humans and agents. It acts as a log of work, actions taken, and hand offs. Issues move between states according to workflows, finite state machines that define the allowed transitions and roles for each state.

Tines acts as a supervisor, assigning tasks to agents across managed services (using your own API keys) as well as local devices (using your own subscriptions).

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

To make an installed CLI target your deployment by default, set the env var in your shell profile (otherwise it talks to `http://localhost:5173`):

```sh
export TINES_API_URL=https://tines.tbuckley.dev
```

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

Publishing lets anyone — including coding agents — install the CLI without cloning this repo. The package publishes as the bare name **`tines`**. The tarball ships only `dist` (see `files` in `packages/cli/package.json`), `prepublishOnly` rebuilds before every publish, and since `@tines/shared` is bundled at build time the only runtime dependency is `commander`.

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

That is the whole setup. npmjs then trusts publishes coming from that exact repo + workflow: GitHub mints a short-lived, workflow-scoped OIDC token per run (the workflow requests `id-token: write`), and pnpm — the pinned 10.x does the exchange natively, so no npm CLI upgrade is needed on the runner — swaps it for a one-shot publish credential. Until the publisher is configured, the publish step fails with an auth error; everything before it still passes. Constraints to know about: GitHub-hosted runners only, and because this repository is private you get no provenance attestations (the workflow deliberately omits `--provenance`).

To publish by hand in a pinch: `cd packages/cli && npm login && pnpm publish --no-git-checks` after setting the version yourself. Prefer merging to `main`.

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
