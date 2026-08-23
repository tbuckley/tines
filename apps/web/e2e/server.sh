#!/usr/bin/env bash
# Boots the app for the e2e suite: fresh local D1 state, migrations, seed
# users/keys/sessions, then the built worker under wrangler dev.
# Invoked by Playwright's webServer (see playwright.config.ts).
set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${E2E_PORT:-8788}"

rm -rf .wrangler-e2e

if [ "${E2E_SKIP_BUILD:-}" != "1" ]; then
	pnpm build
fi

pnpm exec wrangler d1 migrations apply tines --local --persist-to .wrangler-e2e
node e2e/seed.mjs

# --test-scheduled exposes GET /__scheduled?cron=… so the e2e suite can fire
# the scheduled-task sweep deterministically.
exec pnpm exec wrangler dev \
	--port "$PORT" \
	--persist-to .wrangler-e2e \
	--test-scheduled \
	--var "BETTER_AUTH_SECRET:tines-e2e-secret" \
	--var "BETTER_AUTH_URL:http://127.0.0.1:$PORT"
