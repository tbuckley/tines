type FetchInput = Parameters<typeof globalThis.fetch>[0];

function abortReason(signal: AbortSignal): unknown {
	return signal.reason ?? new DOMException('The operation was aborted.', 'AbortError');
}

function waitForSettlement(settled: Promise<void>, signal?: AbortSignal | null): Promise<void> {
	if (!signal) return settled;
	if (signal.aborted) return Promise.reject(abortReason(signal));
	return new Promise((resolve, reject) => {
		const abort = () => {
			cleanup();
			reject(abortReason(signal));
		};
		const cleanup = () => signal.removeEventListener('abort', abort);
		signal.addEventListener('abort', abort, { once: true });
		settled.then(
			() => {
				cleanup();
				resolve();
			},
			(error) => {
				cleanup();
				reject(error);
			}
		);
	});
}

/** Hold same-origin reads while an optimistic focus write is in flight. */
export function createFocusFetch(
	fetch: typeof globalThis.fetch,
	baseUrl: string,
	pending: () => boolean,
	settled: () => Promise<void>
): typeof globalThis.fetch {
	return (input: FetchInput, init?: RequestInit) => {
		let sameOriginGet = false;
		try {
			const method = (
				init?.method ?? (input instanceof Request ? input.method : 'GET')
			).toUpperCase();
			const rawUrl =
				input instanceof Request ? input.url : input instanceof URL ? input.href : input;
			sameOriginGet =
				method === 'GET' && new URL(rawUrl, baseUrl).origin === new URL(baseUrl).origin;
		} catch {
			return fetch(input, init);
		}
		if (!sameOriginGet || !pending()) return fetch(input, init);

		const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
		return (async () => {
			while (pending()) {
				await waitForSettlement(settled(), signal);
			}
			if (signal?.aborted) throw abortReason(signal);
			return fetch(input, init);
		})();
	};
}
