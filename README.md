# tines

An orchestration layer for AI agents, allowing you to create an ecosystem of agents collaborating towards your goals.

The core of Tines is an issue tracker, which makes work legible to both humans and agents. It acts as a log of work, actions taken, and hand offs. Issues move between states according to workflows, finite state machines that define the allowed transitions and roles for each state.

Tines acts as a supervisor, assigning tasks to agents across managed services (using your own API keys) as well as local devices (using your own subscriptions).

## Repository layout

This is a pnpm workspace:

| Package | Path | What it is |
| --- | --- | --- |
| `@tines/web` | `apps/web` | SvelteKit (Svelte 5) app deployed to Cloudflare Workers. Serves the UI and the API (`/api/*`). Uses D1 for the database, [Better Auth](https://better-auth.com) for sign-in (Google OAuth and email magic links via [Cloudflare Email Service](https://developers.cloudflare.com/email-service/)), and [shadcn-svelte](https://shadcn-svelte.com) for UI components. |
| `@tines/cli` | `packages/cli` | The `tines` CLI. Talks to the same API as the web app. |
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
--env preview`. Nothing is promoted to live traffic; the version gets a
preview URL like
`https://<version-prefix>-tines-web-preview.<subdomain>.workers.dev`, which
the workflow posts (and keeps updated) as a PR comment. It uses the same two
Actions secrets as the deploy workflow.

Previews use the `preview` wrangler environment (`env.preview` in
`apps/web/wrangler.jsonc`): a separate worker (`tines-web-preview`) bound to
its own D1 database (`tines-preview`), fully isolated from production data.
Magic-link sign-in works on previews — `BETTER_AUTH_URL` is unset there, so
auth derives its base URL from the request origin (preview URLs differ per
version). Google OAuth does not work on previews (Google doesn't allow
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
