import type { RequestEvent } from '@sveltejs/kit';
import { describe, expect, it } from 'vitest';
import {
	ApiFail,
	assertRunKeyAllowed,
	encodeCursor,
	isControlPlanePath,
	pageResult,
	readPage
} from './core';

/** readPage only touches `url.searchParams`. */
function eventWithUrl(query: string): RequestEvent {
	return { url: new URL(`http://test/api/v1/items${query}`) } as RequestEvent;
}

describe('cursor pagination', () => {
	it('round-trips (created_at, id) through the cursor', () => {
		const cursor = encodeCursor(1723000000123, 'iss_abcDEF123');
		const page = readPage(eventWithUrl(`?cursor=${cursor}`));
		expect(page.cursor).toEqual({ createdAt: 1723000000123, id: 'iss_abcDEF123' });
	});

	it('produces URL-safe cursors (no +, /, =)', () => {
		// ">>>???" forces + and / in plain base64.
		const cursor = encodeCursor(999, '>>>???');
		expect(cursor).not.toMatch(/[+/=]/);
		expect(readPage(eventWithUrl(`?cursor=${cursor}`)).cursor).toEqual({
			createdAt: 999,
			id: '>>>???'
		});
	});

	it('rejects malformed cursors with a 400', () => {
		expect(() => readPage(eventWithUrl('?cursor=%%%not-base64'))).toThrowError(ApiFail);
		try {
			readPage(eventWithUrl('?cursor=aGk')); // "hi": no separator
		} catch (e) {
			expect(e).toBeInstanceOf(ApiFail);
			expect((e as ApiFail).status).toBe(400);
			expect((e as ApiFail).code).toBe('invalid_cursor');
			return;
		}
		throw new Error('expected a malformed cursor to throw');
	});

	it('applies default and max limits', () => {
		expect(readPage(eventWithUrl('')).limit).toBe(50);
		expect(readPage(eventWithUrl('?limit=10')).limit).toBe(10);
		expect(readPage(eventWithUrl('?limit=100000')).limit).toBe(100);
		expect(readPage(eventWithUrl('?limit=0')).limit).toBe(50);
		expect(readPage(eventWithUrl('?limit=banana')).limit).toBe(50);
	});
});

describe('pageResult', () => {
	const row = (id: string, createdAt: number) => ({ id, created_at: createdAt });

	it('trims the +1 probe row and emits a next cursor', () => {
		const rows = [row('c', 3), row('b', 2), row('a', 1)];
		const page = pageResult(rows, 2);
		expect(page.items.map((r) => r.id)).toEqual(['c', 'b']);
		expect(page.next_cursor).toBe(encodeCursor(2, 'b'));
	});

	it('returns a null cursor on the last page', () => {
		const page = pageResult([row('b', 2), row('a', 1)], 2);
		expect(page.items).toHaveLength(2);
		expect(page.next_cursor).toBeNull();
	});

	it('handles an empty page', () => {
		expect(pageResult([], 10)).toEqual({ items: [], next_cursor: null });
	});
});

describe('isControlPlanePath', () => {
	it.each([
		'/api/v1/runners',
		'/api/v1/runners/rnr_1',
		'/api/v1/runners/rnr_1/rotate-token',
		'/api/v1/routing-rules',
		'/api/v1/routing-rules/rul_1',
		'/api/v1/supervisor/settings',
		'/api/v1/issues/iss_1/resume',
		'/api/v1/api-keys',
		'/api/v1/api-keys/key_1'
	])('fences %s', (path) => {
		expect(isControlPlanePath(path)).toBe(true);
	});

	it.each([
		'/api/v1/issues',
		'/api/v1/issues/iss_1',
		'/api/v1/issues/iss_1/comments',
		'/api/v1/issues/iss_1/transition',
		'/api/v1/issues/iss_1/prompt',
		'/api/v1/context',
		'/api/v1/events',
		'/api/v1/projects/prj_1/issues',
		// Similar-looking but distinct segments stay open.
		'/api/v1/runnersandmore',
		'/api/v1/issues/resume'
	])('leaves %s open', (path) => {
		expect(isControlPlanePath(path)).toBe(false);
	});
});

describe('assertRunKeyAllowed', () => {
	const now = 1_723_000_000_000;
	const runKey = { agentRunId: 'arun_1', expiresAt: now + 60_000 };

	it('lets a live run key act on issue endpoints', () => {
		expect(() => assertRunKeyAllowed(runKey, '/api/v1/issues/iss_1/comments', now)).not.toThrow();
	});

	it('403s a run key on every control-plane surface, naming the proposal convention', () => {
		for (const path of [
			'/api/v1/runners',
			'/api/v1/routing-rules/rul_1',
			'/api/v1/supervisor/settings',
			'/api/v1/issues/iss_1/resume',
			'/api/v1/api-keys'
		]) {
			try {
				assertRunKeyAllowed(runKey, path, now);
				throw new Error(`expected a 403 for ${path}`);
			} catch (e) {
				expect(e).toBeInstanceOf(ApiFail);
				expect((e as ApiFail).status).toBe(403);
				expect((e as ApiFail).code).toBe('run_key_forbidden');
				expect((e as ApiFail).message).toContain('Context change:');
			}
		}
	});

	it('401s an expired run key everywhere, before the fence', () => {
		const expired = { agentRunId: 'arun_1', expiresAt: now - 1 };
		for (const path of ['/api/v1/issues/iss_1/comments', '/api/v1/supervisor/settings']) {
			try {
				assertRunKeyAllowed(expired, path, now);
				throw new Error('expected a 401');
			} catch (e) {
				expect(e).toBeInstanceOf(ApiFail);
				expect((e as ApiFail).status).toBe(401);
				expect((e as ApiFail).code).toBe('run_key_expired');
			}
		}
	});

	it('never fences ordinary named keys (no agent_run_id, no expiry)', () => {
		const named = { agentRunId: null, expiresAt: null };
		expect(() => assertRunKeyAllowed(named, '/api/v1/supervisor/settings', now)).not.toThrow();
		expect(() => assertRunKeyAllowed(named, '/api/v1/runners', now)).not.toThrow();
	});
});
