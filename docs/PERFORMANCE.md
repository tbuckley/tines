# Navigation performance

The goal (2026-09-24): every in-app navigation commits in **under 200 ms at
p75 and 400 ms at p95, per route, for real users in production**. Loading
placeholders appear only where they are registered, and how often they show
is measured. Three measurements serve it: the modelled wave count on every
PR, `Server-Timing` per request, and real-user telemetry.

## Weekly stats: `pnpm --filter web perf:stats`

The opt-in weekly-stats probe constructs 524 issues, 28 active states, 1,525 runs and 40 marker-style windows. Its CPU companion runs a frozen pre-refactor arithmetic oracle against complete reports and generated marker windows, then reports the old repeated-preparation shape versus the shared prepared-index shape. It is excluded from the normal unit suite and has no wall-clock gate because local CPU timings vary.

The command builds three fresh isolated Worker/D1 stacks over the same fixture: the pre-change repeated-preparation marker loop, shared preparation with 1,000 irrelevant events, then shared preparation with 10,000 irrelevant events. It collects ten sequential samples for the unfiltered, project-filtered and `compare=none` API, authenticated `/agents`, and lazy evidence. It prints loader phases, query/transfer counts, native `rows_read`, response bytes, stable full-output hashes and the unforced plan for the actual parameterized shipping event query. It fails if baseline/current figures differ or evidence changes between volumes. Set `STATS_PROFILE_PORT` or `STATS_PROFILE_SAMPLES` when needed. `pnpm --filter web perf:stats:cpu` retains the preparation diagnostic and full differential oracle.

## Modelled: `pnpm --filter web perf:nav`

`apps/web/src/lib/server/api/nav-perf.test.ts` runs the real route `load`
functions against the migration-backed in-memory DB with a fixed artificial
latency (20 ms) on every statement. Because the latency dominates, wall-clock ÷
20 ms ≈ the number of **sequential D1 round-trip waves** on the critical path —
which is what actually sets navigation time on a Worker talking to D1.

It is excluded from `pnpm test` (it spends seconds sleeping); `perf:nav` sets
`NAVPERF=1` to opt in and prints the report afterwards. The report prints even
when a page fails, so the completed pages' numbers are never lost, and the
command still exits non-zero.

CI runs `pnpm --filter web perf:nav` as its own step in the `check` job
(~1 s). It fails when a page's `load` stops executing, when the issue page
fetches a statement twice (the zero-duplicates rule below), and when a page
awaits more sequential waves than its budget (`WAVE_BUDGET` in the test).
Waves are **counted**, not timed — a statement's wave is one more than the
deepest statement that had completed when it was issued — so the numbers are
exact on any machine. An over-budget page prints its statements by wave, so
the failure names the chain to cut. Lower a budget when a change earns it;
raising one needs a sentence here saying why.

- `NAVPERF_SERIALIZE=1` forces Kysely's connection mutex back on, reproducing
  the pre-`ConcurrentD1Dialect` baseline — that is how before/after numbers for
  a fan-out change are produced.
- `NAVPERF_OUT=<path>` redirects the report (vitest 4 swallows `console.log`
  from test files, hence the file).

20 ms is a modelling constant, not measured D1 latency: trust the **wave
counts**, not the absolute milliseconds. From US East, one production D1
round trip measured about 20 ms (2026-09-24); a user far from the D1 region
pays several times that per wave, which is why waves are the budget.

## Real: `Server-Timing`

`hooks.server.ts` appends `Server-Timing: auth;dur=<ms>, app;dur=<ms>` to every
response — `auth` is the Better Auth session resolve, `app` the whole handler.
Visible per request in DevTools → Network → Timing on any deployment, with no
OTel plumbing. (`kit.experimental.tracing` would need an exporter on Workers;
that is a project of its own.)

## Real users: `pnpm --filter web perf:report`

Every signed-in page reports, in batches via `sendBeacon` to `/api/telemetry`:

- **Navigations** (`(app)/+layout.svelte`): route id (never the URL), the
  route it came from, navigation type, click-to-mounted ms, how long it waited
  on its `__data.json` after the click, that request's `Server-Timing`, and
  whether a hover or touch preload started it early. A first load (`enter`)
  records time since the document request began.
- **Loading states** (`LoadingState.svelte`): which registered placeholder
  was on screen, on which route, and for how long.

Rows go to the Workers Analytics Engine dataset `tines_perf`
(`tines_perf_preview` for PR previews; the `PERF` binding in
`wrangler.jsonc`), not D1, so reporting costs the app no round trip.
`lib/server/telemetry.ts` validates records and documents the row layout.
`pnpm --filter web perf:report` prints p50/p75/p95 per route, wait and server
time, preload share, and each loading state's rate per 100 navigations. It
needs `CLOUDFLARE_ACCOUNT_ID` and a token with only **Account Analytics:
Read** in `CLOUDFLARE_ANALYTICS_TOKEN`; `--by version` compares deployments,
`--by colo` shows where users are relative to D1, `--preview` reads the
preview dataset.

## Loading states

A placeholder is the exception, so each one is named in
`src/lib/perf/loading-states.ts` with why it is allowed and rendered through
`<LoadingState id="…">`, which reports how long it was on screen.
`loading-states.test.ts` (in `pnpm test`) fails on a `Skeleton` outside a
`LoadingState`, an unregistered id, or a registered id nothing uses.

## Historical baseline, 2026-08-29 (Tines/32)

Sequential waves per page, modelled, before and after lifting the D1 connection
mutex. Kept as the record of what lifting the mutex bought; the loaders have
gained work since, so compare against the current table below, not this one:

| Page | Queries | Waves before | Waves after |
|---|---|---|---|
| `/issues/[project]/[number]` | 26 | 29.1 | 6.8 |
| `/agents` | 10 | 11.2 | 2.3 |
| `/context` | 6 | 6.8 | 2.2 |
| `/issues` | 5 | 5.7 | 2.4 |
| `/projects` | 4 | 4.5 | 2.3 |
| `/activity` | 2 | 2.2 | 1.2 |

## Current, 2026-09-15 (Tines/563)

Two local runs of `pnpm --filter web perf:nav` on the current tree. Query
counts are the stable comparison; waves are derived from
wall-clock and move by a tenth or two between machines:

| Page | Queries | Waves |
|---|---|---|
| `/issues/[project]/[number]` | 11 blocking, 28 total | 3.4–3.5 to first paint, 7.6–7.7 to fully settled |
| `/agents` | 18 | 2.3 |
| `/issues` | 7 | 3.4 |
| `/context` | 7 | 3.4 |
| `/projects` | 3 | 2.2 |
| `/activity` | 2 | 2.2 |

The counts moved because the loaders did — `/agents`, for instance, gained the
fleet queue (2026-09-06) and the first-run checklist (2026-09-09) — not because
a wave was added: every multi-query page still fans out in one or two waves.

## Current, 2026-09-24 (counted waves)

The member-sharing work had grown the issue page to ~9 sequential waves to
first paint (a project lookup, the address, an access check and the sharing
lookups, each its own round trip, ahead of the original two waves); nothing
failed because the probe did not gate waves. It is back to 4: one statement
resolves the address, project, membership and issue id together and access
is decided from that row (`projectAccessFromRow`). That statement matches
the project segment as an id or a name: lists link by name, and resolving
the name first had cost every list click three more waves (7), which the
probe did not see because it addressed the issue by id. It now measures both. `/activity` lost a serial
wave by fetching the owner's and shared events together.

| Page | Queries | Waves (budget) |
|---|---|---|
| `/issues/[project]/[number]` | 12 blocking, 29 total | 4 to first paint (4), 7 settled |
| same, addressed by project name | 12 blocking | 4 to first paint (4) |
| `/agents` | 22 | 2 (2) |
| `/issues` | 7 | 3 (3) |
| `/context` | 7 | 3 (3) |
| `/projects` | 3 | 2 (2) |
| `/activity` | 4 | 3 (3) |

## What a page load may await

The View Transition in `(app)/+layout.svelte` freezes the outgoing page until
`navigation.complete`, so **anything a `load` awaits is perceived latency** and
anything it streams is not. The issue page is the worked example:

- It resolves the address, the project, the viewer's membership and the issue
  id in one statement and decides access from that row, then fetches the
  issue row alongside everything keyed by the issue id alone, then the detail.
- It awaits only what the header, comments and activity feed need.
- The sidebar panels — issue context, effective context, agent activity — are
  returned as promises under `data.deferred`. They render a `Skeleton` (with a
  retry on failure) only until their first value arrives: refreshes replace
  the deferred promises wholesale, so the page tracks the latest value per
  panel (`streamed()` in `+page.svelte`) and keeps the previous one on screen
  while a replacement is in flight, instead of `{#await}` collapsing the
  panel back to a skeleton on every resync.

Result (`pnpm --filter web perf:nav`, 2026-09-24): 12 statements and 4 waves
to first paint, 29 statements and 7 waves to fully settled — from 26
statements and 29.1 waves before Tines/32.

Two rules follow, and the probe asserts the first:

1. **Nothing may be fetched twice.** `getIssueDetail` takes the workflows the
   page is already loading and returns the artifacts the page needs, and
   `explainDispatch` takes the issue row rather than re-reading it. The probe
   reports `duplicated statements` and fails when it is not 0.
2. **Moving something out of `deferred` puts it back on the critical path.**

### Scoped invalidation

The issue page declares `depends('app:issue')`; its mutations and its 5-second
live poll call `invalidate('app:issue')`, not `invalidateAll()`, so posting a
comment no longer re-runs the `(app)` layout load as well. Other pages still
use `invalidateAll()` — their loads are two waves.

### Known wrinkle: streamed responses under `wrangler dev`

Aborting a streamed response mid-flight (navigating away before the panels
land) makes local `wrangler dev` log `Uncaught Error: Network connection lost`.
Measured: it appears with streaming and does not on the same tree without it.
In a full `pnpm test:e2e` run it is logged but harmless — the server keeps
serving and 109/109 non-`magic-link` tests pass. Worth knowing before blaming
it on something else.
