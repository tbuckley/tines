/**
 * Client-side fetching for a page's non-critical panels, with
 * stale-while-revalidate semantics.
 *
 * The server load functions await only what the page needs to render (so
 * navigation is fast); secondary panels fetch their data from the API after
 * hydration via this helper. Deliberately NOT SvelteKit's streamed load
 * promises: a streamed response stays open until every promise settles, and
 * aborting it mid-stream (navigating away, closing the tab) reproducibly
 * wedges `wrangler dev` with "Uncaught Error: Network connection lost" —
 * which local dev, PR previews, and the e2e suite all run on.
 *
 * `source` is read inside an effect, so any reactive state it touches
 * (`data.…`) re-triggers the fetch — every `invalidateAll()` resync hands the
 * page new `data`, refreshing the panels too. The last resolved value stays
 * on screen while a refresh is in flight (no skeleton flicker on the constant
 * resyncs); a stale response that settles after being superseded is ignored.
 * When `resetKey` changes (e.g. navigating from one issue to another, where
 * the component is reused), the value resets to `initial` so the previous
 * record's panels never show against the new one.
 *
 * Effects don't run during SSR, so server-rendered pages show the `initial`
 * placeholders and fill in after hydration.
 */
export function deferred<T, I extends T | null = T>(
	source: () => Promise<T>,
	initial: I,
	resetKey?: () => unknown
) {
	let current = $state.raw<T | I>(initial);
	let loading = $state(true);

	let first = true;
	let lastKey: unknown;

	$effect(() => {
		const key = resetKey?.();
		const promise = source();
		if (!first && resetKey && key !== lastKey) {
			current = initial;
			loading = true;
		}
		first = false;
		lastKey = key;

		let stale = false;
		promise.then(
			(resolved) => {
				if (stale) return;
				current = resolved;
				loading = false;
			},
			(err) => {
				// Keep showing the previous value; the next resync retries.
				if (stale) return;
				loading = false;
				console.error('deferred fetch failed:', err);
			}
		);
		return () => {
			stale = true;
		};
	});

	return {
		get current() {
			return current;
		},
		/** True until the first value arrives (and again after a key reset). */
		get loading() {
			return loading;
		}
	};
}
