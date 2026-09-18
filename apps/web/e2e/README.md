# The e2e suite

Playwright specs against the built worker, served by `e2e/server.sh` under `wrangler dev`
with a seeded local D1. This file records the suite's standing policies, so that a hazard
already solved once is not re-solved per spec (Tines/170).

## Running

- `pnpm test:e2e` from `apps/web`. `pnpm test` does **not** run these; CI does, on every
  pull request, so a green unit run says nothing about end-to-end behaviour.
- `workers: 1`: the suite shares one D1 database. Allocate runtime server names with the
  `uniqueName(stem)` fixture; it combines a cryptographic worker namespace with a monotonic
  counter. Reuse one returned value when equality is under test. Ordinary server objects in
  retained specs use this allocator. `runId` remains temporarily for the four route-contract
  specs owned by Tines/87 and for literal content/identifier fixtures whose exact shape is the
  behavior under test; it is not a naming path for collision-constrained objects.
- `E2E_PORT` (default 8788) moves the server, end to end — two suites can run side by side
  on one machine.
- Setup belongs in a typed worker-scoped world fixture, not the first behavioral test. Tests
  whose only prerequisite is setup must work under `-g`.
- Intentional ordered journeys remain serial: schedule sweep/lifecycle (`schedules`),
  export→import→re-import (`library`), Dana's walkthrough (`first-run-checklist`), agent
  onboarding (`agents-first-run`), and the mutation tails in `projects-archive`,
  `issue-transfer`, and `queue-panel`. Run the complete block/file on a fresh seed.
- `E2E_SKIP_BUILD=1` requires an existing build created with `VITE_TINES_E2E=1`; the
  opt-in exposes the public SvelteKit page-state bridge used by the Agents navigation spec.
- The shared `d1()` CLI helper retries only `SQLITE_BUSY` / `database is locked` process
  diagnostics, for at most six whole-command attempts with bounded backoff. Wrangler runs
  each command as one transactional D1 batch, so replay does not partially duplicate a
  multi-statement operation. Invalid SQL, malformed output, and other permanent failures
  remain first-attempt failures.
- If a polling page is followed by `ProxyController emitErrorEvent`, `Error inside
ProxyWorker`, or `Network connection lost` and the dev server exits, check the workspace
  version with `pnpm --filter @tines/web exec wrangler --version`. This is the
  [Wrangler proxy bug](https://github.com/cloudflare/workers-sdk/issues/14926) fixed by
  [workers-sdk#15252](https://github.com/cloudflare/workers-sdk/pull/15252) and released in
  [Wrangler 4.129.1](https://github.com/cloudflare/workers-sdk/releases/tag/wrangler%404.129.1).
  Wrangler 4.129.1 or newer is the project-level mitigation: run
  `pnpm install --frozen-lockfile`, stop the server process you own, and relaunch it so it
  uses the installed version. Verify the same process survives a caught 30-second missing
  locator timeout while at least three `/api/v1/events` polls succeed, responds to
  `/api/time`, shows an externally posted comment through polling, and still responds
  after the browser context closes. Short scripts or locator timeouts are not required as
  a workaround for this known fault.
- `e2e/` is typechecked by nothing — `pnpm check` runs `svelte-check` against
  `.svelte-kit/tsconfig.json`, whose `include` is `src/`, `test/`, `tests/` and the vite
  config (Tines/159). To check it ad hoc, drop a `tsconfig.e2e-check.json` in `apps/web`:

  ```json
  {
  	"compilerOptions": {
  		"strict": true,
  		"skipLibCheck": true,
  		"module": "esnext",
  		"moduleResolution": "bundler",
  		"target": "es2022",
  		"allowJs": true,
  		"noEmit": true,
  		"types": ["node"],
  		"typeRoots": ["../../node_modules/.pnpm/@types+node@<version>/node_modules/@types"]
  	},
  	"include": ["e2e/**/*.ts", "e2e/**/*.mjs"]
  }
  ```

  then `pnpm exec tsc -p tsconfig.e2e-check.json`, and delete the file afterwards. The
  `typeRoots` line is needed because pnpm does not link `@types/node` into
  `apps/web/node_modules`; without it every `Buffer`/`node:*` reference errors.

## Shared fixtures and accounts

Import `test` and `expect` from `./fixtures`. Declare the browser identity explicitly with
`test.use({ signedIn: ALICE })` (or the dedicated account the journey owns); public and
magic-link cases leave the default `null`. Use `apiFor(account)` for ordinary bearer API
access and `workerRequest` for raw worker-scoped requests. Keep the built-in `request` for
cookie, unauthenticated, or transport behavior under test.

`signedIn` wraps the normal Playwright context lazily, so API-only tests do not launch a
browser. It does not sign in contexts created manually with `browser.newContext()`; call
`signIn` explicitly for deliberate multi-context and account-switch cases. It also does not
reset preferences: preserve explicit `resetFocus` calls and the dedicated DANA, SPEND,
PAGINATION, AGENTS_FIRST_RUN, API_ISOLATION, EXPLAINER_REMEDIES, STOPPED_FIRST_RUN,
MANAGED_SETTINGS, CAROL, and TRANSFER_RUNTIME account contracts.

To stress D1 CLI contention on fresh isolated stacks, run the affected files sequentially
with a new port for each invocation. Do not use `--repeat-each` or run these invocations in
parallel because the specs within one invocation intentionally share D1 fixtures:

```sh
for iteration in 1 2 3 4 5; do
	CI=1 E2E_PORT=$((18950 + iteration)) pnpm test:e2e \
		runner-fencing.spec.ts spend-matrix.spec.ts workflow-package-import.spec.ts \
		> "d1-stress-${iteration}.log" 2>&1 || exit 1
done
```

## Motion policy

**Reduced motion is the suite default**, set once in `playwright.config.ts`
(`use: { reducedMotion: 'reduce' }`). Do not re-derive it per spec.

Why: the specs assert state, not motion, and the app already honours the preference —
`prefersReducedMotion()` (`src/lib/format.ts`) feeds a `dur()` used by every Svelte
transition, and `app.css` does the same for view transitions and the AlertDialog. So a
transition that a locator can trip over is 0 ms under the default. CI's contended runner is
exactly where the untamed windows widen.

**Opting out** is file-level and only for a spec whose subject _is_ the animation — today
`dialog-animation.spec.ts` and `dialog-pending.spec.ts`:

```ts
test.use({ reducedMotion: 'no-preference' });
```

An in-test `page.emulateMedia({ reducedMotion: 'reduce' })` still overrides that, which is
how those files' reduced-motion halves keep working.

`ui.spec.ts` carries a guard test asserting
`matchMedia('(prefers-reduced-motion: reduce)').matches` — the only gate the policy has.
History for whoever sees it go red: the context-level option **did not reach the page** on
Playwright 1.62.1, which is why the two animation specs used to call `page.emulateMedia`
with a comment saying so. 1.63.0 fixes it (measured with the same Chromium build). If the
guard reds after a bump, the regression is back — fix the bump, do not reintroduce a
per-spec `emulateMedia` workaround.

## Rows in animated lists

Svelte 5's `out()` sets `element.inert = true` for the whole outro and clears it at
`outroend`, at least one frame later **even at 0 ms**. So in a list whose `<li>` carries
`transition:` or `out:`, locate rows as:

```ts
page.locator('li:not([inert])', { hasText: name });
```

How much reduced motion alone buys, measured (Tines/170, the `?workflow=` filter swap in
`context.spec.ts`, CPU throttled 100x right before the swap, unscoped `page.locator('li')`,
count read once with no auto-retry):

| motion          | result                                                     |
| --------------- | ---------------------------------------------------------- |
| `no-preference` | **10/10 failed** — `2 rows`, strict mode would have thrown |
| `reduce`        | **10/10 passed**                                           |

So at that site reduced motion is on its own sufficient: the 180 ms outro collapses to one
frame and the sample never lands inside it. Read that as "not observable", not as "gone" —
`out()` still sets `inert` unconditionally for that frame, and a pass is the failure mode of
every hazard on this page. Scoping is the cheap belt-and-braces, and it is what makes a
locator sound rather than lucky, so keep it wherever a row is located and then acted on.

Components that put an outro on the `<li>` itself today — these are the lists that need
scoping:

| component                               | directive                       |
| --------------------------------------- | ------------------------------- |
| `ContextItemList.svelte:45`             | `transition:slide`              |
| `EffectiveContextView.svelte:47,71,100` | `transition:slide`              |
| `RunRow.svelte:46`                      | `transition:slide`              |
| `ArtifactsPanel.svelte:296`             | `transition:slide`              |
| `EventList.svelte:83`                   | `in:slide out:fade`             |
| `RelationsCard.svelte:260`              | `animate:flip transition:slide` |

`IssueList.svelte:62` (`animate:flip in:fade`) and `ScheduleList.svelte:153` (`in:fade`) are
`in:`-only and never go `inert`; `WorkflowEditor.svelte` animates `<p>`/`<div>`, not its
`<li>`; the `<li>`s on `/settings/labels` and in `RoutingRuleRow.svelte` carry no directive
at all. Do not scope what needs no scoping — but re-derive this table rather than trusting
it, with `grep -rn -A6 '<li' --include='*.svelte' src`, since a component gains a directive
without anyone thinking about this file.

### Sites deliberately left unscoped

Reviewed for Tines/170 and correct as they stand. Do not "fix" them:

| site                                  | why it is sound                                                                                                                            |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `labels.spec.ts:138`                  | `/settings/labels` rows carry no directive                                                                                                 |
| `run-row.spec.ts:134` (`deadRuleRow`) | `RoutingRuleRow` carries no directive                                                                                                      |
| `schedules.spec.ts:394`               | `ScheduleList` is `in:`-only                                                                                                               |
| `workflow-editor.spec.ts:62`          | locates `<p>`, not a row                                                                                                                   |
| `run-row.spec.ts:172` (`failedRow`)   | a `RunRow`, but nothing in that path removes a row, so no outro runs (it is not `--repeat-each`-safe, for an unrelated reason — see below) |
| `runner.spec.ts:314`, `:519`          | `RunRow`s, saved by `.first()` — see the caveat below                                                                                      |

The `.first()` caveat is worth stating, because it is half a fix: it prevents the strict-mode
violation, not the race. `.first()` can still resolve to a row that is on its way out and
`inert`, and both sites go on to click inside the row (`runner.spec.ts:318`, `:527`). They
are sound today only because neither path removes a row while the locator is live —
`runner.spec.ts:527`'s click additionally sits in a `toPass` retry. If either grows a
removal, scope it; prefer `li:not([inert])` over `.first()` in new code.

The second hazard, which reduced motion does **not** close: the pre-flush window after a
client-side navigation or filter change — the URL has flipped but the DOM still holds the
old rows, so the count is right and the _text_ is stale. `toHaveCount(1)` followed by
`toContainText(...)` is sound only for a locator that can never match a transient element;
otherwise fold the claim into one retrying assertion.

## Hydration

A click landing before the listeners attach is swallowed. Two helpers in `helpers.ts`
cover it:

- `gotoHydrated(page, url)` for a navigation that a click, fill or upload follows: it
  waits for network idle, which is when SvelteKit has attached its listeners, so the first
  event is seen. It costs about half a second per call, so a page that is only read stays
  on a bare `page.goto`.
- `clickUntil` (retries the click until the expected state holds) as belt-and-braces
  around a first click, rather than a sleep or a bare click.

## Geometry

Read layout through `readSettled` in `helpers.ts`: two reads a beat apart that agree. A
single `boundingBox()` is one frame, and the issue page keeps reflowing after the target is
visible as streamed panels resolve (Tines/123) — which reduced motion does not touch, since
it is reflow rather than transition. `readSettled(read, { bestEffort: true })` returns the
last read instead of throwing when the layout never settles, for callers whose own
assertions name that failure better than a timeout here would. Pass a `timeout` so a layout
that never settles fails there rather than burning the test timeout, and keep `T`
JSON-comparable — reads are compared with `JSON.stringify`.

## Verifying a flake fix

A green suite is not evidence — the failure mode of every hazard above is a pass. The house
standard (from Tines/154) is a forced repro: throttle the CPU after the page has settled,
show the old code red N/N and the new code green N/N.

```ts
const cdp = await page.context().newCDPSession(page);
await cdp.send('Emulation.setCPUThrottlingRate', { rate: 20 });
// ... trigger the swap the locator races ...
```

**`--repeat-each N` is not a flake probe for this suite** — it re-runs the fixture-creating
tests too, and they write to the one shared D1, so every repeat sees the rows the previous
repeats left. `run-row.spec.ts:178` counts failed-run rows and goes 1 → 2 → 4 → 6 across
repeats for that reason alone; on a server whose `.wrangler-e2e` already holds an earlier
run's rows it reds on the first repeat. Measured under Tines/170: `--repeat-each 3` is 633
passed / 3 failed, and all three failures are this or timing drift in a five-minute run
(`dialog-pending.spec.ts:257` measures a real outro and is 24/24 in isolation), not the
behaviour under test. Repeat a single spec file against a freshly seeded server instead.

Then mutate your own fix (revert the locator, flip the config line) and confirm the check
reds on that mutation alone.

## Dana, and the one-way account

`first-run-checklist.spec.ts` walks a brand-new account (`DANA` in
`constants.mjs`) from nothing to its first agent run through the UI checklist.
The checklist is derived from "this account has no runs" and retires the moment
one exists, so the walk is **one-way**: no other spec may depend on Dana being
run-free, and new cases in that file must sort after the walk. Alice always has
seeded runs and Bob is run-free but is used by the explainer specs, which is why
the walk gets an account of its own.

The Dana daemon must use a productive harness for any work whose success or run count is
asserted. A custom harness that only exits zero still leaves the issue eligible: the
supervisor correctly judges it stalled and retries it up to the attempt limit.
`first-run-checklist.spec.ts` therefore moves each issue with the delivered run key and
waits for one terminal `completed` / `advanced` run before continuing the serial walk.

Stress this one-way journey with fresh seeded servers, not `--repeat-each`:

```sh
CI=1 pnpm test:e2e first-run-checklist.spec.ts
for iteration in $(seq 1 10); do
	CI=1 E2E_SKIP_BUILD=1 pnpm test:e2e first-run-checklist.spec.ts \
		> "first-run-stress-${iteration}.log" 2>&1 || exit 1
done
```
