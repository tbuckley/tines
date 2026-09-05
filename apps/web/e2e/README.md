# The e2e suite

Playwright specs against the built worker, served by `e2e/server.sh` under `wrangler dev`
with a seeded local D1. This file records the suite's standing policies, so that a hazard
already solved once is not re-solved per spec (Tines/170).

## Running

- `pnpm test:e2e` from `apps/web`. `pnpm test` does **not** run these; CI does, on every
  pull request, so a green unit run says nothing about end-to-end behaviour.
- `workers: 1`: the suite shares one D1 database. Specs still use per-run unique names
  (`runId` in `helpers.ts`).
- `E2E_PORT` (default 8788) moves the server, end to end — two suites can run side by side
  on one machine.
- A single-test run of a `describe.serial` spec generally fails: the fixture is created in
  the file's first test. Run the whole file.
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

## Motion policy

**Reduced motion is the suite default**, set once in `playwright.config.ts`
(`use: { reducedMotion: 'reduce' }`). Do not re-derive it per spec.

Why: the specs assert state, not motion, and the app already honours the preference —
`prefersReducedMotion()` (`src/lib/format.ts`) feeds a `dur()` used by every Svelte
transition, and `app.css` does the same for view transitions and the AlertDialog. So a
transition that a locator can trip over is 0 ms under the default. CI's contended runner is
exactly where the untamed windows widen.

**Opting out** is file-level and only for a spec whose subject *is* the animation — today
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
`outroend`, at least one frame later **even at 0 ms**. Reduced motion narrows that window;
it does not remove it. So in a list whose `<li>` carries `transition:` or `out:`, locate
rows as:

```ts
page.locator('li:not([inert])', { hasText: name });
```

Components that animate an `<li>` with an outro today: `ContextItemList`,
`EffectiveContextView`, `RunRow`. `IssueList` and `ScheduleList` use `in:`-only directives
and never go `inert` — do not scope what needs no scoping.

The second hazard, which reduced motion does **not** close: the pre-flush window after a
client-side navigation or filter change — the URL has flipped but the DOM still holds the
old rows, so the count is right and the *text* is stale. `toHaveCount(1)` followed by
`toContainText(...)` is sound only for a locator that can never match a transient element;
otherwise fold the claim into one retrying assertion.

## Hydration

A click landing before the listeners attach is swallowed. Use `clickUntil` from
`helpers.ts` (retries the click until the expected state holds) rather than a sleep or a
bare click.

## Geometry

Read layout through `readSettled` in `helpers.ts`: two reads a beat apart that agree. A
single `boundingBox()` is one frame, and the issue page keeps reflowing after the target is
visible as streamed panels resolve (Tines/123) — which reduced motion does not touch, since
it is reflow rather than transition. `readSettled(read, { bestEffort: true })` returns the
last read instead of throwing when the layout never settles, for callers whose own
assertions name that failure better than a timeout here would.

## Verifying a flake fix

A green suite is not evidence — the failure mode of every hazard above is a pass. The house
standard (from Tines/154) is a forced repro: throttle the CPU after the page has settled,
show the old code red N/N and the new code green N/N.

```ts
const cdp = await page.context().newCDPSession(page);
await cdp.send('Emulation.setCPUThrottlingRate', { rate: 20 });
// ... trigger the swap the locator races ...
```

Then mutate your own fix (revert the locator, flip the config line) and confirm the check
reds on that mutation alone.
