import type { Project } from '@tines/shared';
import { describe, expect, it, vi } from 'vitest';
import { defaultProjectId, FocusOperations, resolveClientFocus } from './focus';
import { FocusHint } from './focus.svelte';

const project = (id: string, name = id) => ({ id, name }) as Project;
const deferred = <T = void>() => {
	let resolve!: (value: T | PromiseLike<T>) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
};

describe('defaultProjectId', () => {
	const two = [project('prj_a'), project('prj_b')];

	it('is the focus when it is one of the projects', () => {
		expect(defaultProjectId(two, 'prj_b', 'prj_a')).toBe('prj_b');
	});

	it('falls back to the last project under All projects', () => {
		expect(defaultProjectId(two, null, 'prj_b')).toBe('prj_b');
	});

	it('ignores a focus or a last project that is no longer listed', () => {
		expect(defaultProjectId(two, 'prj_gone', 'prj_a')).toBe('prj_a');
		expect(defaultProjectId(two, null, 'prj_gone')).toBe('');
	});

	it('is empty at multiple projects with nothing to fall back to', () => {
		expect(defaultProjectId(two, null, null)).toBe('');
	});

	it('uses the only project and is empty with none', () => {
		expect(defaultProjectId([project('prj_a')], null, null)).toBe('prj_a');
		expect(defaultProjectId([], null, null)).toBe('');
	});
});

describe('resolveClientFocus', () => {
	const a = project('a', 'A');
	const b = project('b', 'B');

	it.each([
		['uses server focus without a hint', undefined, b, [a, b], b],
		['keeps an explicit All projects hint', null, b, [a, b], null],
		['uses a live hint', a, b, [a, b], a],
		['rejects an absent hint', a, b, [b], b],
		['rejects a hint excluded with archived projects', a, null, [b], null]
	] as const)('%s', (_name, hint, server, live, expected) => {
		expect(resolveClientFocus(hint, server, live)).toBe(expected);
	});

	it('returns the fresh live-list project when its name changed', () => {
		const fresh = project('a', 'New name');
		expect(resolveClientFocus(a, b, [fresh, b])).toBe(fresh);
	});
});

describe('FocusOperations', () => {
	it('waits for all pending work and work registered while waiting', async () => {
		const first = deferred();
		const second = deferred();
		const operations = new FocusOperations();
		operations.track(first.promise);
		const done = vi.fn();
		const waiting = operations.settled().then(done);
		operations.track(second.promise);
		first.resolve();
		await Promise.resolve();
		expect(done).not.toHaveBeenCalled();
		second.resolve();
		await waiting;
		expect(done).toHaveBeenCalledOnce();
		expect(operations.pending).toBe(false);
	});

	it('releases waiters after rejection', async () => {
		const failed = deferred();
		const operations = new FocusOperations();
		operations.track(failed.promise);
		failed.reject(new Error('nope'));
		await expect(operations.settled()).resolves.toBeUndefined();
	});

	it('takes a finite predecessor snapshot without waiting on its successor', async () => {
		const first = deferred();
		const second = deferred();
		const operations = new FocusOperations();
		operations.track(first.promise);
		const predecessor = operations.predecessor();
		const successor = predecessor.then(() => second.promise);
		operations.track(successor);
		first.resolve();
		await predecessor;
		let finished = false;
		void operations.settled().then(() => (finished = true));
		await Promise.resolve();
		expect(finished).toBe(false);
		second.resolve();
		await operations.settled();
	});
});

describe('FocusHint ownership', () => {
	it('does not let an obsolete operation clear a newer hint', () => {
		const hint = new FocusHint();
		const oldOwner = hint.set(project('a'));
		hint.set(project('b'));
		expect(hint.clearIfCurrent(oldOwner)).toBe(false);
		expect(hint.project?.id).toBe('b');
	});

	it('lets the current operation roll its hint back', () => {
		const hint = new FocusHint();
		const owner = hint.set(project('a'));
		expect(hint.clearIfCurrent(owner)).toBe(true);
		expect(hint.project).toBeUndefined();
	});
});
