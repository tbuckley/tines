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
 *  counts), or the top of the bottom chrome, whichever is higher. A modal dialog covers the
 *  chrome, so pass `chrome: false` for an anchor inside one. */
export function visibleBottom(chrome = true): number {
	const vv = window.visualViewport;
	const viewBottom = vv ? vv.offsetTop + vv.height : window.innerHeight;
	return Math.min(viewBottom, (chrome ? bottomChromeTop() : null) ?? Infinity);
}

/** The nearest ancestor that scrolls, and so clips, its content; null when that is the page. */
export function scrollParent(el: HTMLElement): HTMLElement | null {
	for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
		const { overflowY } = getComputedStyle(p);
		if (overflowY === 'auto' || overflowY === 'scroll') return p;
	}
	return null;
}

/** The max-height for a list under an anchor `anchorHeight` tall inside a scrolling box whose
 *  visible part runs from `top` to `limit`. The box scrolls to show the list, which lifts the
 *  anchor as far as its top edge, so the room is the box less the anchor wherever the anchor
 *  sits now. */
export function listMaxHeightInScroller(top: number, limit: number, anchorHeight: number): number {
	return listMaxHeight(top + anchorHeight, limit);
}

/**
 * While a list is open under `anchor`, keep `apply(maxHeightPx)` current on scroll and resize.
 * On the page: end the list above the bottom chrome, and on phones (chrome visible) scroll the
 * anchor to the top once. In a scrolling box (a dialog's body): fit the list to the box, which
 * the caller scrolls to show it. Returns the cleanup.
 */
export function fitBelow(anchor: HTMLElement, apply: (px: number) => void): () => void {
	const scroller = scrollParent(anchor);
	const chrome = anchor.closest('[aria-modal="true"]') === null;
	const measure = () => {
		const rect = anchor.getBoundingClientRect();
		const limit = visibleBottom(chrome);
		if (!scroller) return apply(listMaxHeight(rect.bottom, limit));
		const box = scroller.getBoundingClientRect();
		apply(listMaxHeightInScroller(box.top, Math.min(box.bottom, limit), rect.height));
	};
	measure();

	// One frame late, so iOS's own focus scroll runs first instead of fighting ours.
	let scrollFrame =
		scroller || bottomChromeTop() === null
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
