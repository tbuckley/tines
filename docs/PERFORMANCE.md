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

## PR previews: `pnpm --filter web perf:preview`

A PR's own number, before it merges, on real Workers and D1:

```sh
PREVIEW_LOGIN_TOKEN=… pnpm --filter web perf:preview --pr 305 --base 299
```

`scripts/perf-preview.mjs` signs in to the preview as the probe user
(`docs/preview-login.md`), makes sure that user owns a `perf-probe` project
(250 issues, so the list is full and its counts cover more than one page; the
newest has 30 comments and a text artifact), then clicks through the main
transitions in Chromium: open an issue from the list, back, open it again, the
Agents, Workflows and Issues tabs, a list filter, and Issues to Agents and
back. Each
number is the app's own navigation record, the same one real users report,
captured in the browser rather than sent, so probes stay out of
`perf:report --preview`.

`--base N` measures a second preview in the same run, interleaving the two
round by round, and prints the difference in p50. Pick the newest preview
that predates the change, since every preview reads the one shared
`tines-preview` database and only the code differs. `--rounds` (default 5)
sets the number of tours per preview after one warm-up, and `--json FILE` keeps
every sample.

The timings are from wherever the script runs. It prints the Cloudflare
location the preview was served from, so compare runs from the same place.
A preview only answers the sign-in once it was uploaded after its
`PREVIEW_LOGIN_TOKEN` secret was set and from a build that has the route
(main after PR #299). The script says so on a 404.

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

## Current, 2026-09-25 (counted waves)

The member-sharing work had grown the issue page to ~9 sequential waves to
first paint (a project lookup, the address, an access check and the sharing
lookups, each its own round trip, ahead of the original two waves), and a
list click, which addresses the project by name, paid three more resolving
it. Nothing failed because the probe did not gate waves and addressed the
issue by id. Since then (#296 and after):

- One statement resolves the address (by id or name), project, membership
  and the issue's head columns; access is decided from that row
  (`projectAccessFromRow`).
- `getIssueDetail` takes that head and starts its own reads alongside the
  issue row instead of after it.
- `loadWorkflows` selects states and transitions through the same
  visibility predicate as the workflows, so all three run in one wave
  instead of two. Every page that lists workflows gains a wave.
- `listArtifacts` reads the issue, items, versions and files in one wave
  instead of four. The probe issue now carries an artifact, as most worked
  issues do; without one the probe had hidden two of those waves.
- `/activity` fetches the owner's and shared events together.

| Page | Waves to first paint (budget) |
|---|---|
| `/issues/[project]/[number]`, by id or by name | 2 (2); 5 fully settled |
| `/issues` | 2 (2) |
| `/agents` | 2 (2) |
| `/context` | 2 (2) |
| `/projects` | 1 (1) |
| `/activity` | 3 (3) |

## What a view transition captures

`onNavigate` in `(app)/+layout.svelte` wraps each navigation in a view
transition. Before the browser runs the update, it snapshots the old page:
the root and every element with a `view-transition-name`, each separately,
and the page is frozen while it does. That time counts toward every
navigation leaving the page, so the number of named elements is a
navigation cost.

Measured 2026-09-26 on a 100-row issue list in headless Chromium: 205 named
elements (a title and a state per row, plus the chrome) took 410–550 ms to
capture; with the rows unnamed, 20 ms. Rendering the rows themselves took
about 10 ms. So list rows are named only when they morph: `issueMorph`
(`lib/issue-morph.svelte.ts`) holds the issue page a navigation enters or
leaves, the layout sets it and flushes before starting the transition, and
`IssueList` names only that row. Keep new shared-element names to what one
navigation actually morphs, never one per list item.

Headless Chromium has no GPU, so its absolute capture times are higher than
a real browser's, but the cost still grows with the number of named elements.

Row links go to the issue's canonical path (`/issues/<project id>/<number>`).
A link by project name loads the page, then the page replaces the URL with
the canonical one (`OwnerIssuePage.svelte`), a second navigation that loads
the data again and cuts the first transition short.

## What a page load may await

SvelteKit runs a client navigation's `load` before anything changes on
screen: the old page stays as it is until the data arrives, and only then
does `onNavigate` (and the View Transition in `(app)/+layout.svelte`) run. So
**anything a `load` awaits is time the click appears to do nothing**, and
anything it streams is not. The issue page is the worked example:

- It resolves the address, the project, the viewer's membership and the
  issue's id, project, workflow and state in one statement and decides
  access from that row, then fetches the issue row alongside everything
  keyed by those columns, the detail's comments, links, context summary and
  artifacts included.
- It awaits only what the header, comments and activity feed need.
- The sidebar panels — issue context, effective context, agent activity — are
  returned as promises under `data.deferred`. They render a `Skeleton` (with a
  retry on failure) only until their first value arrives: refreshes replace
  the deferred promises wholesale, so the page tracks the latest value per
  panel (`streamed()` in `+page.svelte`) and keeps the previous one on screen
  while a replacement is in flight, instead of `{#await}` collapsing the
  panel back to a skeleton on every resync.

Result (`pnpm --filter web perf:nav`, 2026-09-25): 2 waves to first paint
and 5 to fully settled — from 29.1 waves before Tines/32.

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
