// Open-dialog count shared by `Modal` and `DialogHost`. bits-ui traps focus and
// makes the page behind pointer-inert, but it does not hide it from assistive
// tech (no `inert`/`aria-hidden`, unlike Radix), so the root layout marks the
// app content `inert` whenever anything modal is open. `inert` rather than
// `aria-hidden`: it removes the subtree from the accessibility tree *and* the
// tab order, and cannot strand focus inside a hidden subtree.
let openCount = $state(0);

export const backgroundInert = {
	get active(): boolean {
		return openCount > 0;
	},
	/**
	 * Marks the background inert until the returned release is called — usable
	 * directly as an `$effect` cleanup. Ref-counted, so a dialog stacked on
	 * another keeps the background inert until every one of them has closed.
	 */
	acquire(): () => void {
		openCount++;
		let released = false;
		return () => {
			if (released) return;
			released = true;
			openCount--;
		};
	}
};
