/** Consumer-level Tab containment while the shared Modal owns parking/restoration. */
export function containDialogTab(event: KeyboardEvent, contentSelector: string) {
	if (event.key !== 'Tab') return;
	const dialog = document.querySelector(contentSelector)?.closest('[role="dialog"]');
	const controls = dialog?.querySelectorAll<HTMLElement>(
		'button:not([disabled]),a[href],summary,input,select,[tabindex="0"]'
	);
	const visible = controls ? [...controls].filter((el) => el.getClientRects().length > 0) : [];
	if (!visible.length) return;
	const first = visible[0],
		last = visible[visible.length - 1];
	if (event.shiftKey && document.activeElement === first) {
		event.preventDefault();
		last.focus();
	} else if (!event.shiftKey && document.activeElement === last) {
		event.preventDefault();
		first.focus();
	}
}
