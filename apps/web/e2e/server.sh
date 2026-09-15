#!/usr/bin/env bash
# Boots the app for the e2e suite: fresh local D1 state, migrations, seed
# users/keys/sessions, then the built worker under wrangler dev.
# Invoked by Playwright's webServer (see playwright.config.ts).
set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${E2E_PORT:-8788}"
# The same secret helpers.ts signs session cookies with; one source of truth.
AUTH_SECRET=$(node --input-type=module -e "import { AUTH_SECRET } from './e2e/constants.mjs'; console.log(AUTH_SECRET)")

rm -rf .wrangler-e2e

if [ "${E2E_SKIP_BUILD:-}" != "1" ]; then
	VITE_TINES_E2E=1 pnpm build
fi

pnpm exec wrangler d1 migrations apply tines --local --persist-to .wrangler-e2e
node e2e/seed.mjs

# --test-scheduled exposes GET /__scheduled?cron=… so the e2e suite can fire
# the scheduled-task sweep deterministically.
#
# --host: wrangler dev rewrites the Host of every request to the first route
# in wrangler.jsonc (the production custom domain), so without this the
# worker sees `http://tines.tbuckley.dev/...` and Better Auth — whose
# SvelteKit handler only claims requests whose origin matches its base URL —
# lets every /api/auth/* request fall through to the app's 404 page.
exec pnpm exec wrangler dev \
	--port "$PORT" \
	--host "127.0.0.1:$PORT" \
	--persist-to .wrangler-e2e \
	--test-scheduled \
	--var "BETTER_AUTH_SECRET:$AUTH_SECRET" \
	--var "BETTER_AUTH_URL:http://127.0.0.1:$PORT" \
	--var "PUBLIC_WORKFLOW_PUBLISHING_ENABLED:true" \
	--var "PUBLIC_WORKFLOW_MODERATOR_USER_IDS:usr_e2e_alice" \
	--var "PUBLIC_WORKFLOW_REPORT_HMAC_SECRET:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=" \
	--var "PUBLIC_WORKFLOW_APPEAL_CONTACT:mailto:appeals@e2e.test" \
	--var "PUBLIC_WORKFLOW_MODERATION_QUEUE_READY:true" \
	--var "PUBLIC_WORKFLOW_MODERATION_JOURNEY_VERIFIED:true" \
	--var "SECRET_ENCRYPTION_KEY:e2e-only-secret-encryption-key" \
	--var "USAGE_SCALE_SQL_TRACE:${USAGE_SCALE_SQL_TRACE:-}" \
	--var "STATS_SCALE_REPEAT_PREPARATION:${STATS_SCALE_REPEAT_PREPARATION:-}"
