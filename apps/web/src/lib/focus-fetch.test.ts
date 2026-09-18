import { describe, expect, it, vi } from 'vitest';
import { createFocusFetch } from './focus-fetch';

const deferred = <T = void>() => {
	let resolve!: (value: T | PromiseLike<T>) => void;
	const promise = new Promise<T>((yes) => (resolve = yes));
	return { promise, resolve };
};

function harness() {
	const gate = deferred();
	let pending = true;
	const response = new Response('ok');
	const original = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response);
	const fetch = createFocusFetch(
		original,
		'https://tines.test/app',
		() => pending,
		() => gate.promise
	);
	return {
		fetch,
		original,
		response,
		release() {
			pending = false;
			gate.resolve();
		}
	};
}

describe('createFocusFetch', () => {
	it.each([
		['string', '/issues/__data.json'],
		['URL', new URL('https://tines.test/issues')],
		['Request', new Request('https://tines.test/api/v1/preferences')]
	])('waits for a same-origin GET passed as %s', async (_name, input) => {
		const h = harness();
		const result = h.fetch(input);
		expect(h.original).not.toHaveBeenCalled();
		h.release();
		await expect(result).resolves.toBe(h.response);
		expect(h.original).toHaveBeenCalledWith(input, undefined);
	});

	it.each([
		['method override', '/issues', { method: 'post' }],
		['Request method', new Request('https://tines.test/issues', { method: 'PATCH' }), undefined],
		['cross origin', 'https://example.test/issues', undefined]
	])('bypasses for %s', async (_name, input, init) => {
		const h = harness();
		await expect(h.fetch(input, init)).resolves.toBe(h.response);
		expect(h.original).toHaveBeenCalledWith(input, init);
	});

	it('takes the idle fast path and preserves arguments, responses, and errors', async () => {
		const response = new Response('same');
		const original = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response);
		const fetch = createFocusFetch(original, 'https://tines.test/', () => false, vi.fn());
		const init = { headers: { 'x-test': 'yes' } };
		await expect(fetch('/api', init)).resolves.toBe(response);
		expect(original).toHaveBeenCalledWith('/api', init);
		const error = new Error('network');
		original.mockRejectedValueOnce(error);
		await expect(fetch('/api')).rejects.toBe(error);
	});

	it('rejects an aborted waiting GET without dispatching it', async () => {
		const h = harness();
		const controller = new AbortController();
		const request = h.fetch('/issues', { signal: controller.signal });
		const reason = new Error('stop');
		controller.abort(reason);
		await expect(request).rejects.toBe(reason);
		expect(h.original).not.toHaveBeenCalled();
	});

	it('honors a RequestInit signal override', async () => {
		const h = harness();
		const requestController = new AbortController();
		const override = new AbortController();
		const result = h.fetch(
			new Request('https://tines.test/issues', { signal: requestController.signal }),
			{
				signal: override.signal
			}
		);
		override.abort();
		await expect(result).rejects.toHaveProperty('name', 'AbortError');
		expect(h.original).not.toHaveBeenCalled();
	});

	it('rechecks pending work before dispatch', async () => {
		const first = deferred();
		const second = deferred();
		let phase = 1;
		const original = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response());
		const fetch = createFocusFetch(
			original,
			'https://tines.test/',
			() => phase !== 0,
			() => (phase === 1 ? first.promise : second.promise)
		);
		const result = fetch('/issues');
		phase = 2;
		first.resolve();
		await Promise.resolve();
		expect(original).not.toHaveBeenCalled();
		phase = 0;
		second.resolve();
		await result;
		expect(original).toHaveBeenCalledOnce();
	});
});
