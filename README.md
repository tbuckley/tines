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

```sh
cd apps/web
pnpm wrangler d1 create tines             # then paste the database_id into wrangler.jsonc
pnpm db:migrate:remote
pnpm wrangler secret put BETTER_AUTH_SECRET
pnpm wrangler secret put GOOGLE_CLIENT_ID
pnpm wrangler secret put GOOGLE_CLIENT_SECRET
# update BETTER_AUTH_URL and EMAIL_FROM in wrangler.jsonc "vars" for production
# (see "Magic-link sign-in" above for onboarding your sending domain)
pnpm deploy
```

## Scripts

From the repo root:

- `pnpm dev` — run the web app dev server (with local D1 bindings emulated)
- `pnpm build` — build all packages
- `pnpm check` — typecheck all packages (svelte-check + tsc)
- `pnpm cli <command>` — run the CLI in dev mode
