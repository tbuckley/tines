# Navigation performance

Two measurements, one modelled and one real.

## Modelled: `pnpm --filter web perf:nav`

`apps/web/src/lib/server/api/nav-perf.test.ts` runs the real route `load`
functions against the migration-backed in-memory DB with a fixed artificial
latency (20 ms) on every statement. Because the latency dominates, wall-clock ÷
20 ms ≈ the number of **sequential D1 round-trip waves** on the critical path —
which is what actually sets navigation time on a Worker talking to D1.

It is excluded from `pnpm test` (it spends seconds sleeping); `perf:nav` sets
`NAVPERF=1` to opt in and prints `/tmp/navperf.txt` afterwards.

- `NAVPERF_SERIALIZE=1` forces Kysely's connection mutex back on, reproducing
  the pre-`ConcurrentD1Dialect` baseline — that is how before/after numbers for
  a fan-out change are produced.
- `NAVPERF_OUT=<path>` redirects the report (vitest 4 swallows `console.log`
  from test files, hence the file).

20 ms is a modelling constant, not measured D1 latency: trust the **ratios**,
not the absolute milliseconds.

## Real: `Server-Timing`

`hooks.server.ts` appends `Server-Timing: auth;dur=<ms>, app;dur=<ms>` to every
response — `auth` is the Better Auth session resolve, `app` the whole handler.
Visible per request in DevTools → Network → Timing on any deployment, with no
OTel plumbing. (`kit.experimental.tracing` would need an exporter on Workers;
that is a project of its own.)

## Baseline, 2026-08-29 (Tines/32)

Sequential waves per page, modelled, before and after lifting the D1 connection
mutex:

| Page | Queries | Waves before | Waves after |
|---|---|---|---|
| `/issues/[project]/[number]` | 26 | 29.1 | 6.8 |
| `/agents` | 10 | 11.2 | 2.3 |
| `/context` | 6 | 6.8 | 2.2 |
| `/issues` | 5 | 5.7 | 2.4 |
| `/projects` | 4 | 4.5 | 2.3 |
| `/activity` | 2 | 2.2 | 1.2 |

## What a page load may await

The View Transition in `(app)/+layout.svelte` freezes the outgoing page until
`navigation.complete`, so **anything a `load` awaits is perceived latency** and
anything it streams is not. The issue page is the worked example:

- It resolves the issue row alone (one statement — the project-name lookup is
  folded into it), then fans everything else out behind it.
- It awaits only what the header, comments and activity feed need.
- The sidebar panels — issue context, effective context, agent activity — are
  returned as promises under `data.deferred` and rendered inside `{#await}`
  with a `Skeleton` and a retry on failure.

Result (`pnpm perf:nav`): 21 statements, ~3.4 waves to first paint, ~5.5 to
fully settled — from 26 statements and 29.1 waves before Tines/32.

Two rules follow, and the probe enforces the first:

1. **Nothing may be fetched twice.** `getIssueDetail` takes the workflows the
   page is already loading and returns the artifacts the page needs, and
   `explainDispatch` takes the issue row rather than re-reading it. The probe
   reports `duplicated statements`; it should stay at 0.
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
