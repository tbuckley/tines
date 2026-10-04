import { prefersReducedMotion } from '$lib/format';

/** Tallest a below-anchor list grows (`max-h-64`). */
export const LIST_MAX_PX = 256;
/** Shortest cap: about three rows, so a scrollable list still reads as a list. */
export const LIST_MIN_PX = 96;
/** Breathing room between the list's bottom edge and whatever covers the screen. */
export const LIST_GAP_PX = 8;

/** The max-height for a list under an anchor whose bottom is `anchorBottom`, when the usable
 *  screen ends at `limit` (both in viewport px). */
export function listMaxHeight(anchorBottom: number, limit: number): number {
	return Math.min(
		LIST_MAX_PX,
		Math.max(LIST_MIN_PX, Math.floor(limit - anchorBottom - LIST_GAP_PX))
	);
}

/** The top of the app's visible bottom chrome (the phone tab bar), or null when none is shown. */
export function bottomChromeTop(): number | null {
	let top: number | null = null;
	for (const el of document.querySelectorAll('[data-bottom-chrome]')) {
		if (el.getClientRects().length === 0) continue;
		const t = el.getBoundingClientRect().top;
		top = top === null ? t : Math.min(top, t);
	}
	return top;
}

/** Viewport y where usable space ends: the visible viewport's bottom (so the on-screen keyboard
 *  counts), or the top of the bottom chrome, whichever is higher. */
export function visibleBottom(): number {
	const vv = window.visualViewport;
	const viewBottom = vv ? vv.offsetTop + vv.height : window.innerHeight;
	return Math.min(viewBottom, bottomChromeTop() ?? Infinity);
}

/**
 * While a list is open under `anchor`: on phones (bottom chrome visible) scroll the anchor to
 * the top once, then keep `apply(maxHeightPx)` current on scroll and resize. Returns the cleanup.
 */
export function fitBelow(anchor: HTMLElement, apply: (px: number) => void): () => void {
	const measure = () =>
		apply(listMaxHeight(anchor.getBoundingClientRect().bottom, visibleBottom()));
	measure();

	// One frame late, so iOS's own focus scroll runs first instead of fighting ours.
	let scrollFrame =
		bottomChromeTop() === null
			? 0
			: requestAnimationFrame(() => {
					scrollFrame = 0;
					anchor.scrollIntoView({
						block: 'start',
						behavior: prefersReducedMotion() ? 'auto' : 'smooth'
					});
				});

	let measureFrame = 0;
	const schedule = () => {
		if (measureFrame) return;
		measureFrame = requestAnimationFrame(() => {
			measureFrame = 0;
			measure();
		});
	};
	const vv = window.visualViewport;
	const opts = { capture: true, passive: true } as const;
	window.addEventListener('scroll', schedule, opts);
	window.addEventListener('resize', schedule);
	vv?.addEventListener('resize', schedule);
	vv?.addEventListener('scroll', schedule);

	return () => {
		cancelAnimationFrame(scrollFrame);
		cancelAnimationFrame(measureFrame);
		window.removeEventListener('scroll', schedule, opts);
		window.removeEventListener('resize', schedule);
		vv?.removeEventListener('resize', schedule);
		vv?.removeEventListener('scroll', schedule);
	};
}
