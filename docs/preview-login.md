# Preview sign-in

`POST /api/preview-login` signs a script or agent in to a **PR preview** as
one fixed test user (`preview-probe@tines.invalid`, "Preview Probe"), with no
email round trip. It exists so latency probes, Playwright scripts and Claude
sessions can drive a preview directly instead of going through CI.

## What keeps it out of production

All three must hold, or the route answers 404 as if it did not exist:

1. **The build.** `__TINES_PREVIEW_LOGIN__` (`apps/web/vite.config.ts`) is
   true only when `TINES_BUILD_CHANNEL=preview` (what `preview.yml` builds)
   or in the e2e build. `deploy.yml` builds with `TINES_BUILD_CHANNEL=production`,
   so the production bundle compiles the route to a 404.
2. **The worker.** `PREVIEW_LOGIN_TOKEN` is a secret on the preview worker
   (`tines-web-preview`) only, at least 32 characters. Unset or short, the
   route 404s. It is also refused on the production host.
3. **The request.** `Authorization: Bearer <PREVIEW_LOGIN_TOKEN>`; a wrong
   token gets 401.

It never signs in as a user the caller names, so the token reaches only the
probe user in the shared preview database. Sessions last one hour.

## Setup (once)

```sh
cd apps/web
openssl rand -base64 36 | pnpm exec wrangler secret put PREVIEW_LOGIN_TOKEN --env preview
```

Give the same value to whoever will call it (for a Claude environment, as an
environment secret named `PREVIEW_LOGIN_TOKEN`). To revoke, put a new value;
existing sessions still run out within the hour.

## Use

```sh
curl -sS -X POST "https://pr-<n>-tines-web-preview.<subdomain>.workers.dev/api/preview-login" \
  -H "authorization: Bearer $PREVIEW_LOGIN_TOKEN" -c cookies.txt
curl -sS -b cookies.txt "https://pr-<n>-…/api/v1/issues"
```

The JSON response also carries `cookie: { name, value }`, for planting in a
Playwright browser context with `context.addCookies`.

`e2e/preview-login.spec.ts` covers the flow; `lib/server/preview-login.ts`
holds the gates and their unit tests.
