import { describe, expect, it, vi } from 'vitest';
import { TransferReviewController, type TransferReviewIdentity } from './issue-transfer-review';

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}

function harness() {
	const controller = new TransferReviewController();
	const identity: TransferReviewIdentity = {
		open: true,
		issueId: 'iss_a',
		destinationId: 'prj_a'
	};
	const success = vi.fn();
	const failure = vi.fn();
	const settled = vi.fn();
	const run = (transport: () => Promise<string>) =>
		controller.review({
			issueId: identity.issueId,
			destinationId: identity.destinationId,
			current: () => identity,
			transport,
			onSuccess: success,
			onFailure: failure,
			onFinally: settled
		});
	controller.open(identity.issueId);
	return { controller, identity, success, failure, settled, run };
}

describe('TransferReviewController', () => {
	it('abandons a deferred success across close and reopen', async () => {
		const h = harness();
		const pending = deferred<string>();
		const request = h.run(() => pending.promise);
		h.controller.invalidate();
		h.identity.open = false;
		h.controller.open(h.identity.issueId);
		h.identity.open = true;
		pending.resolve('old preview');
		await request;
		expect(h.success).not.toHaveBeenCalled();
		expect(h.settled).not.toHaveBeenCalled();
	});

	it('abandons a deferred rejection after reset', async () => {
		const h = harness();
		const pending = deferred<string>();
		const request = h.run(() => pending.promise);
		h.controller.invalidate();
		h.identity.open = false;
		pending.reject(new Error('obsolete'));
		await request;
		expect(h.failure).not.toHaveBeenCalled();
		expect(h.settled).not.toHaveBeenCalled();
	});

	it('rejects callbacks after the issue or destination changes', async () => {
		for (const change of [
			(identity: TransferReviewIdentity) => (identity.issueId = 'iss_b'),
			(identity: TransferReviewIdentity) => (identity.destinationId = 'prj_b')
		]) {
			const h = harness();
			const pending = deferred<string>();
			const request = h.run(() => pending.promise);
			change(h.identity);
			pending.resolve('wrong identity');
			await request;
			expect(h.success).not.toHaveBeenCalled();
			expect(h.settled).not.toHaveBeenCalled();
		}
	});

	it('lets a newer request settle without obsolete finally clearing it', async () => {
		const h = harness();
		const first = deferred<string>();
		const second = deferred<string>();
		const firstRequest = h.run(() => first.promise);
		const secondRequest = h.run(() => second.promise);
		first.resolve('first');
		await firstRequest;
		expect(h.success).not.toHaveBeenCalled();
		expect(h.settled).not.toHaveBeenCalled();
		second.resolve('second');
		await secondRequest;
		expect(h.success).toHaveBeenCalledWith('second', expect.any(Object));
		expect(h.settled).toHaveBeenCalledTimes(1);
	});

	it('accepts success, failure and finally for the current owner', async () => {
		const good = harness();
		await good.run(async () => 'preview');
		expect(good.success).toHaveBeenCalledWith('preview', expect.any(Object));
		expect(good.settled).toHaveBeenCalledTimes(1);

		const bad = harness();
		await bad.run(async () => {
			throw new Error('failed');
		});
		expect(bad.failure).toHaveBeenCalledWith(expect.any(Error), expect.any(Object));
		expect(bad.settled).toHaveBeenCalledTimes(1);
	});
});
