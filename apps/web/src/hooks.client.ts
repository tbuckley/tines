import { createFocusFetch } from '$lib/focus-fetch';
import { focusHint } from '$lib/focus.svelte';

export function init(): void {
	const currentFetch = window.fetch.bind(window);
	window.fetch = createFocusFetch(
		currentFetch,
		document.baseURI,
		() => focusHint.pending,
		() => focusHint.settled()
	);
}
