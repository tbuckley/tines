# Design — Tines/29: Modal focus trap + inert background (migrate to bits-ui Dialog)

Follows `research-findings` v1. All file:line claims below were re-verified against `main` in this run.

## In scope / Out of scope

**In scope** (everything the issue requests, plus the two things research showed are required to actually deliver it):

1. Rebuild `apps/web/src/lib/components/Modal.svelte` internally on **bits-ui `Dialog`** (imported directly, not via a generated `ui/dialog` — rationale below), keeping the public API (`open`, `title`, `size`, `children`, `onclose`) and visual shape byte-compatible so **zero consumer edits** are needed.
2. Real focus trap (Tab cycles inside the dialog) — provided by bits-ui.
3. **`inert` background** — *not* provided by bits-ui (research §3); we build a small shared helper and wire both `Modal` and `DialogHost` to it, since an open AlertDialog has exactly the same gap.
4. Delete the hand-rolled portal, Escape handler, body scroll lock, and focus move/restore in favour of bits-ui's.
5. A global `prefers-reduced-motion` rule for the dialog enter/exit animations, so adopting the `data-open:animate-in` idiom doesn't silently drop Tines/28's `prefersReducedMotion()` gate (this also fixes the already-unguarded `ui/alert-dialog`).
6. Keep `apps/web/e2e/artifact-viewer.spec.ts` green: four of its five tests unchanged; rewrite the one that *depends on the absence of the trap*; add Tab-cycle and inert assertions.
7. One-sentence `CLAUDE.md` amendment recording when wrapping bits-ui directly is allowed (this PR sets that precedent).

**Out of scope:**

- Migrating any of the 13 Modal consumers to a different API — explicitly excluded by the issue ("the migration is internal to `Modal.svelte`").
- Generating `ui/dialog` or touching `ui/alert-dialog` (except that the new CSS rule and inert wiring benefit it from outside).
- Any server/API/data-model change. There are none; this is a pure front-end change with no migrations.

## Approach and alternatives

**Chosen: build `Modal.svelte` directly on `bits-ui`'s `Dialog` primitives** (`Dialog.Root/Portal/Overlay/Content/Title/Close`). Tom pre-approved this on 2026-09-02 ("If there's a good reason not to [use shadcn dialog], go forward with using bits-ui Dialog as the base") and research §4 established the good reason: shadcn's generated `dialog-content.svelte` statically imports an X icon we'd disable (`showCloseButton={false}`), forcing either a second icon library (lucide) or — with `"iconLibrary": "tabler"` — the barrel import `CLAUDE.md` bans; and after Modal's overrides essentially nothing of the generated files survives (the passthroughs are one-liners, `Content`'s layout defaults are the inverse of Modal's, and every override is a fragile tailwind-merge resolution).

**Rejected — shadcn `ui/dialog` + wrapper:** viable fallback if a human overrules (leave `iconLibrary` as lucide, `showCloseButton={false}`, never tabler), but pays a dependency for nothing we keep.

**Rejected — hand-roll the trap/inert on the current Modal:** reimplements what a maintained primitive already does well (layering, iOS scroll lock, focus scope stack), and the issue explicitly asks for the migration.

## Detailed design

### 1. `Modal.svelte` rebuilt

Everything in today's file goes except the props block, the header/body markup, and the portal-target comment:

- **Delete:** the `<script module>` `openModals`/`previousBodyOverflow` scroll-lock counter, the focus `$effect` (move to close button / restore), `use:portal`, the `<svelte:window onkeydown>` Escape handler *including* its `!e.defaultPrevented` guard (bits-ui's `EscapeLayer` layering supersedes the cooperation it existed for), `svelte/transition` fade/scale, `dur()`, the `prefersReducedMotion` import (still used elsewhere in the app — only Modal's import goes), and the manual `role`/`aria-modal`/`aria-labelledby` attributes (the primitive sets them).
- **New shape:**

```svelte
<script lang="ts">
	import { Dialog } from 'bits-ui';
	import type { Snippet } from 'svelte';
	import IconX from '@tabler/icons-svelte/icons/x';
	import { backgroundInert } from '$lib/components/background-inert.svelte';

	let { open = $bindable(false), title, size = 'md', children, onclose }: { … } = $props();

	let closeButton = $state<HTMLButtonElement | null>(null);

	// onclose fires on every close path (X, Escape, overlay click) — it is what
	// the four `open={true}` unbound consumers use to unmount.
	function onOpenChange(next: boolean) {
		if (!next) onclose?.();
	}

	$effect(() => {
		if (!open) return;
		return backgroundInert.acquire();
	});
</script>

<Dialog.Root bind:open {onOpenChange}>
	<Dialog.Portal>
		<Dialog.Overlay
			class="data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0 fixed inset-0 z-50 bg-black/50"
		/>
		<!-- (carry over the existing keyboard-anchoring comment) -->
		<Dialog.Content
			class="bg-background data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95 fixed top-4 left-1/2 z-50 flex w-[calc(100%-2rem)] {size === 'xl'
				? 'max-w-4xl'
				: 'max-w-md'} -translate-x-1/2 flex-col overflow-hidden rounded-xl border shadow-lg duration-150 sm:top-1/2 sm:-translate-y-1/2"
			style="max-height: calc(100dvh - 2rem - env(safe-area-inset-bottom, 0px))"
			onOpenAutoFocus={(e) => {
				e.preventDefault();
				closeButton?.focus({ preventScroll: true });
			}}
		>
			<div class="flex shrink-0 items-start justify-between gap-3 px-6 pt-5 pb-3">
				<Dialog.Title class="text-lg font-semibold">{title}</Dialog.Title>
				<Dialog.Close
					bind:ref={closeButton}
					class="text-muted-foreground hover:text-foreground hover:bg-muted -mt-1 -mr-2 inline-flex size-9 shrink-0 items-center justify-center rounded-md"
					aria-label="Close"
				>
					<IconX size={18} />
				</Dialog.Close>
			</div>
			<div class="min-h-0 flex-1 overflow-y-auto overscroll-contain px-6 pb-6">
				{@render children()}
			</div>
		</Dialog.Content>
	</Dialog.Portal>
</Dialog.Root>
```

Notes pinning the choices:

- **Portal target:** bits-ui `Dialog.Portal` defaults to `document.body`, same as today's `use:portal`. Keep the default and carry over the comment explaining *why* body (`<main>` carries a `view-transition-name` → stacking context; z-40 header/tab-bar siblings). (research §6.7)
- **Focus on open:** bits-ui's default autofocus is not guaranteed to pick the close button, and the e2e (`artifact-viewer.spec.ts:198`) asserts it is focused. `onOpenAutoFocus` + `preventDefault` + explicit `closeButton.focus()` keeps Tines/28's behaviour exactly. Focus restore on close uses bits-ui's default (`onCloseAutoFocus` untouched); `artifact-viewer.spec.ts:202` guards it.
- **Trap:** `Dialog.Content` defaults `trapFocus = true` with `loop` — nothing to pass.
- **Scroll lock:** `Dialog.Content` defaults `preventScroll = true`, using bits-ui's shared multi-lock manager. This also removes the latent conflict where an AlertDialog's `resetBodyStyle()` (a whole-`style`-attribute snapshot restore) could wipe Modal's imperative `overflow: hidden` (research §3 bonus).
- **`onclose` on every path:** today `onclose` fires for X-click, overlay-click, and Escape (all route through `close()`). `onOpenChange(false)` covers the same three under bits-ui. Do **not** also set `open = false` inside `onOpenChange` — `bind:open` on `Dialog.Root` already updates it, and the four unbound `open={true}` consumers (`CancelRunDialog.svelte:67`, `agents/+page.svelte:1227`, `agents/+page.svelte:1397`, `issues/[project]/[number]/+page.svelte:1075` — note: research §6.3 said one; grep found four) unmount via `onclose` exactly as before. For those, local `open` flips false without propagating, which is today's behaviour too.
- **`aria-describedby`:** `Modal` renders no `Dialog.Description`; verify during implementation that content's `aria-describedby` resolves to nothing dangling (research §6.6). If bits-ui emits a described-by pointing at a non-existent id, pass `aria-describedby={undefined}` on `Dialog.Content` — the header/body layout leaves no room for a real description.
- **Animation timing:** `duration-150` matches today's 150 ms; `zoom-in-95` is the closest tw-animate step to today's `scale start: 0.96`.

### 2. Background-`inert` helper (the half bits-ui doesn't provide)

New file `apps/web/src/lib/components/background-inert.svelte.ts`:

```ts
// Open-dialog count shared by Modal and DialogHost. bits-ui traps focus and
// pointer events but does NOT hide the page behind from assistive tech
// (no inert/aria-hidden — unlike Radix), so the root layout toggles `inert`
// on the app content whenever anything modal is open.
let openCount = $state(0);

export const backgroundInert = {
	get active(): boolean {
		return openCount > 0;
	},
	/** Returns the release function — usable directly as an $effect cleanup. */
	acquire(): () => void {
		openCount++;
		return () => {
			openCount--;
		};
	}
};
```

`apps/web/src/routes/+layout.svelte` wraps the page in a layout-neutral inert target — a *sibling* of both `<DialogHost />` and the `document.body` portal target, so dialog content itself is never inert:

```svelte
<div style="display: contents" inert={backgroundInert.active || undefined}>
	{@render children()}
</div>
<DialogHost />
```

(`inert` is DOM-tree-scoped, so it applies through a `display: contents` box-less wrapper; `|| undefined` keeps the attribute entirely absent when no dialog is open.)

`DialogHost.svelte` gets the same one-liner `$effect` as Modal (`if (!open) return; return backgroundInert.acquire();`) — an AlertDialog stacked on a Modal takes the count to 2, so the background stays inert until both close.

**`inert` over `aria-hidden`** (research §6.1): removes the subtree from the accessibility tree *and* tab order, is baseline-available, and can't strand focus inside a hidden subtree.

**Ordering risk to verify at implementation:** on close, bits-ui restores focus to the previously-focused element, which lives *inside* the wrapper we mark inert. If the restore ever runs while the wrapper is still inert, the focus call silently no-ops. The e2e assertion `expect(opener).toBeFocused()` (`artifact-viewer.spec.ts:202`) is the guard; if it fails, release the inert count synchronously in `onOpenChange(false)` instead of only in the `$effect` cleanup.

### 3. Reduced-motion rule

`app.css`'s only `prefers-reduced-motion` block (~line 340) covers view transitions; `ui/alert-dialog`'s `data-open:animate-in` animations are unguarded today, and new-Modal would inherit the same gap. Add to `app.css`, next to the existing block:

```css
/* bits-ui dialog/alert-dialog enter/exit animations (tw-animate-css). The
   variant-compiled selectors can't be matched by a plain `.animate-in`, so
   target the primitives' data attributes instead. */
@media (prefers-reduced-motion: reduce) {
	[data-dialog-overlay],
	[data-dialog-content],
	[data-alert-dialog-overlay],
	[data-alert-dialog-content] {
		animation: none !important;
	}
}
```

bits-ui stamps those data attributes on its rendered elements. With `animation: none`, bits-ui's presence layer sees no running animation and removes the node immediately — verify at implementation that Escape-close still hides the dialog promptly under emulated reduced motion (Playwright `reducedMotion: 'reduce'`, or DevTools emulation manually).

### 4. `CLAUDE.md` amendment

Append one sentence to the `ui/` bullet (CLAUDE.md ~line 12): components in `apps/web/src/lib/components/` may wrap a bits-ui primitive directly when the shadcn variant would add only a dependency or dead overrides (precedent: `Modal.svelte`; see Tines/29). Keeps the next agent from re-litigating research §4.

## Error handling / migrations / rollout

- No data model, API, or migration changes. Ships as one PR; merging deploys it (per repo convention).
- Backward compatibility bar: **all 13 consumers untouched and visually identical.** The only deliberate behaviour changes are the three the issue asks for or that follow from layering: Tab is trapped, background is inert, and Escape now closes only the topmost dialog when an AlertDialog is stacked on a Modal (research §6.4 — treated as the correct behaviour; the e2e that asserted one-press-closes-both is rewritten below).

## Testing strategy

No new unit tests: everything here is DOM/focus behaviour, and the vitest suite runs in a node environment. The strategy is e2e + targeted manual checks.

**`apps/web/e2e/artifact-viewer.spec.ts`:**

- Tests 1, 2, 3, 5 (`long markdown stays dismissable`, `folder set stays within viewport`, `page behind does not scroll`, `Escape closes and returns focus`) — unchanged; they must pass as-is. They cover close-button-in-viewport, body scroll lock (behavioural wheel test), Escape, and focus park/restore.
- **Rewrite test 4** (`two modals open at once…`, lines 163-188): its stacking path — focus a background trigger and press Enter — is impossible by construction once the trap and inert land, *which is the fix*. The nested-lock property is still worth guarding, and one legitimate stacking path exists: `ContextItemEditor`'s Delete button raises a `confirmDialog()` AlertDialog *from inside its open Modal* (`ContextItemEditor.svelte:263`, reached from `/context`). New test (same file is fine; retitle it):
  1. `beforeAll`: seed ~30 prompt context items via `POST /api/v1/context` so `/context` scrolls on the phone viewport.
  2. Open the edit modal for one item, click its Delete button → AlertDialog on top; `expect(page.getByRole('dialog')).toHaveCount(2)` (alertdialog role included via `getByRole('alertdialog')` if the count locator misses it) and `wheelPageBehind === 0`.
  3. Press Escape → only the AlertDialog closes (layered Escape, §6.4): modal still visible, page still locked.
  4. Press Escape again → 0 dialogs, `expectPageBehindScrolls`.
- **New: Tab-cycle (trap) test**, on the artifact viewer: with the dialog open and the close button focused, Shift+Tab must land on the *last* focusable element inside the dialog (not the page), and Tab from there must return to the close button; assert `document.activeElement` stays within the dialog across several Tabs.
- **New: inert test**, on the artifact viewer: while open, `page.locator('[inert]')` exists and contains the `View long-doc` opener (e.g. `opener.evaluate((el) => el.closest('[inert]') !== null)`); after close, no `[inert]` remains and the opener is focusable again (test 5 already proves it receives focus).
- **Mutation-verify** the two new tests, as Tines/28 did: temporarily pass `trapFocus={false}` and comment out the inert wrapper, confirm each new test fails, revert.

**Manual verification:**

- Visual pass over all 13 consumer surfaces (7 components: `ArtifactViewerDialog`, `ArtifactsPanel`, `ContextItemEditor`, `LaunchPromptDialog`, `NewIssueModal`, `ScheduleList`, `CancelRunDialog`; 6 route pages: settings/api-keys, projects, projects/[id], agents (6 modals), issues/[project]/[number]) — header pinned, one scroll region, `md`/`xl` widths, phone-viewport top anchoring.
- The four unbound `open={true}` consumers specifically: close each via X, Escape, and overlay click; confirm they unmount and focus is restored (they rely purely on `onclose`).
- Screen-reader spot check (VoiceOver): with a modal open, `VO`-navigation cannot reach page content behind; announcement uses the modal title.
- Reduced-motion emulation: dialogs appear/disappear instantly and close is not stuck.

**Gates:** `pnpm check`, `pnpm test`, `pnpm format`, `pnpm test:e2e` (not run by `pnpm test` — run it explicitly before claiming green).

## Implementation steps

1. `pnpm install` (bits-ui is already a dependency on `main`; the clone just has no `node_modules`).
2. Add `apps/web/src/lib/components/background-inert.svelte.ts` (helper above).
3. Wrap `{@render children()}` in `apps/web/src/routes/+layout.svelte` with the `display: contents` inert div.
4. Rebuild `apps/web/src/lib/components/Modal.svelte` per §1 (delete the module script, the focus/scroll/Escape/portal machinery, and transitions; add the Dialog tree + inert `$effect`). Check the `aria-describedby` and inert/focus-restore-ordering notes while here.
5. Add the `$effect` acquiring `backgroundInert` to `DialogHost.svelte`.
6. Add the reduced-motion rule to `apps/web/src/app.css` beside the existing block.
7. Amend the `ui/` bullet in `CLAUDE.md`.
8. Update `apps/web/e2e/artifact-viewer.spec.ts`: seed context items in `beforeAll`, rewrite test 4 against `/context` + `ContextItemEditor`, add the Tab-cycle and inert tests; mutation-verify both new tests.
9. Run the gates; do the manual pass; fix fallout.

## Assumptions recorded (non-blocking, per research §6)

- Escape closing only the topmost stacked dialog is correct behaviour, not a regression (§6.4).
- The inert helper wires `DialogHost` too, in this issue — same gap, one-line fix, severable if review wants the diff minimal (§6.1).
- The CSS-animation idiom replaces Svelte transitions, with the reduced-motion rule compensating (§6.5).
- Portal target stays `document.body` (§6.7).
- `CLAUDE.md` gains the bits-ui sentence in the same PR (§4d) — repo-owned doc, not shared context.
