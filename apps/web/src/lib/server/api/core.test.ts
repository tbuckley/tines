import type { RequestEvent } from '@sveltejs/kit';
import { describe, expect, it, vi } from 'vitest';
import {
	ApiFail,
	api,
	assertRunKeyAllowed,
	decodeCursor,
	errorResponse,
	encodeCursor,
	isControlPlanePath,
	readArchived,
	jsonifyMethodNotAllowed,
	pageResult,
	readPage,
	requestDispatchEffects
} from './core';

const queued = vi.hoisted(() => vi.fn());
vi.mock('$lib/server/supervisor/engine', () => ({ queueDispatchPass: queued }));

function requestEvent(): RequestEvent {
	return {
		platform: { env: {} as Env, ctx: { waitUntil: vi.fn() } },
		request: new Request('http://test/api/v1/test'),
		url: new URL('http://test/api/v1/test')
	} as unknown as RequestEvent;
}

describe('request dispatch effects', () => {
	it('does not schedule without a signal', async () => {
		queued.mockClear();
		const response = await api((event) => {
			requestDispatchEffects(event, 'usr_one');
			return new Response('quiet');
		})(requestEvent());
		expect(await response.text()).toBe('quiet');
		expect(queued).not.toHaveBeenCalled();
	});

	it('coalesces repeated signals and binds them to the authenticated owner', async () => {
		queued.mockClear();
		const event = requestEvent();
		const response = await api(async (wrapped) => {
			const first = requestDispatchEffects(wrapped, 'usr_one');
			expect(requestDispatchEffects(wrapped, 'usr_one')).toBe(first);
			first.signalDispatch();
			first.signalDispatch();
			return new Response('ok');
		})(event);
		expect(response.status).toBe(200);
		expect(queued).toHaveBeenCalledOnce();
		expect(queued).toHaveBeenCalledWith(event.platform, 'usr_one');
	});

	it('drains a committed signal even when the handler later fails', async () => {
		queued.mockClear();
		const response = await api((event) => {
			const effects = requestDispatchEffects(event, 'usr_one');
			effects.signalDispatch();
			effects.signalDispatch();
			effects.signalDispatch();
			throw new ApiFail(422, 'later_failure', 'later failure');
		})(requestEvent());
		expect(response.status).toBe(422);
		expect(queued).toHaveBeenCalledOnce();
	});

	it('isolates concurrent requests by owner', async () => {
		queued.mockClear();
		let release!: () => void;
		const gate = new Promise<void>((resolve) => (release = resolve));
		const firstEvent = requestEvent();
		const first = api(async (event) => {
			requestDispatchEffects(event, 'usr_one').signalDispatch();
			await gate;
			return new Response('one');
		})(firstEvent);
		const secondEvent = requestEvent();
		const second = await api((event) => {
			requestDispatchEffects(event, 'usr_two').signalDispatch();
			return new Response('two');
		})(secondEvent);
		expect(second.status).toBe(200);
		expect(queued).toHaveBeenCalledWith(secondEvent.platform, 'usr_two');
		release();
		await first;
		expect(queued).toHaveBeenCalledWith(firstEvent.platform, 'usr_one');
		expect(queued).toHaveBeenCalledTimes(2);
	});

	it('closes and removes the collector after success and unexpected failure', async () => {
		queued.mockClear();
		let captured!: ReturnType<typeof requestDispatchEffects>;
		const event = requestEvent();
		const ok = await api((wrapped) => {
			captured = requestDispatchEffects(wrapped, 'usr_one');
			return new Response('ok');
		})(event);
		expect(ok.status).toBe(200);
		captured.signalDispatch();
		expect(queued).not.toHaveBeenCalled();
		expect(() => requestDispatchEffects(event, 'usr_one')).toThrow(
			'Dispatch effects requested outside api()'
		);

		const failed = await api((wrapped) => {
			requestDispatchEffects(wrapped, 'usr_two').signalDispatch();
			throw new Error('boom');
		})(requestEvent());
		expect(failed.status).toBe(500);
		expect(queued).toHaveBeenCalledOnce();
	});

	it('does not let a scheduling failure replace the handler response', async () => {
		queued.mockImplementationOnce(() => {
			throw new Error('waitUntil failed');
		});
		const error = vi.spyOn(console, 'error').mockImplementation(() => {});
		const response = await api((event) => {
			requestDispatchEffects(event, 'usr_one').signalDispatch();
			return new Response('preserved', { status: 201 });
		})(requestEvent());
		expect(response.status).toBe(201);
		expect(await response.text()).toBe('preserved');
		expect(error).toHaveBeenCalledWith('Failed to schedule dispatch pass:', expect.any(Error));
		error.mockRestore();
	});

	it('rejects owner rebinding and use outside the wrapper', async () => {
		expect(() => requestDispatchEffects(requestEvent(), 'usr_one')).toThrow(
			'Dispatch effects requested outside api()'
		);
		const response = await api((event) => {
			requestDispatchEffects(event, 'usr_one');
			requestDispatchEffects(event, 'usr_two');
			return new Response('unreachable');
		})(requestEvent());
		expect(response.status).toBe(500);
	});
});

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

	it.each(['', 'aGk', 'OnhpZA', encodeCursor(Number.NaN, 'id')])(
		'rejects an invalid decoded tuple: %s',
		(raw) => expect(() => decodeCursor(raw)).toThrowError(ApiFail)
	);

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
	// Everything the fence covers, asserted method by method: the label
	// library and the fleet reads are readable, so this table is what keeps a
	// future `readable` flag from quietly opening the rest of the control
	// plane (Tines/93, widened for the fleet queue in Tines/256).
	it.each([
		['/api/v1/runners', 'POST'],
		['/api/v1/runners/rnr_1', 'PATCH'],
		['/api/v1/runners/rnr_1', 'DELETE'],
		['/api/v1/runners/rnr_1/rotate-token', 'POST'],
		['/api/v1/routing-rules', 'GET'],
		['/api/v1/routing-rules/rul_1', 'PATCH'],
		['/api/v1/supervisor/settings', 'PUT'],
		['/api/v1/issues/iss_1/resume', 'POST'],
		// Key metadata stays fenced even to a read.
		['/api/v1/api-keys', 'GET'],
		['/api/v1/api-keys/key_1', 'DELETE'],
		// Minting, renaming, and deleting terms is taxonomy, not classification.
		['/api/v1/labels', 'POST'],
		['/api/v1/labels/lbl_1', 'PATCH'],
		['/api/v1/labels/lbl_1', 'DELETE'],
		// Bulk library writes are a control-plane action: an agent proposes
		// context changes, it does not apply a whole library.
		['/api/v1/import', 'GET'],
		['/api/v1/import', 'POST'],
		['/api/v1/library/install', 'POST'],
		// Archiving is an operator act: an agent must not freeze the project it
		// is working in, nor thaw one a human froze.
		['/api/v1/projects/prj_1/archive', 'POST'],
		['/api/v1/projects/prj_1/unarchive', 'POST'],
		// The project focus is its owner's UI state: an agent has none, and
		// reading one would let it guess at scope it must not have.
		['/api/v1/preferences', 'GET'],
		['/api/v1/preferences', 'PATCH']
	])('fences %s %s', (path, method) => {
		expect(isControlPlanePath(path, method)).toBe(true);
	});

	it.each([
		['/api/v1/issues', 'GET'],
		['/api/v1/issues', 'POST'],
		['/api/v1/issues/iss_1', 'PATCH'],
		['/api/v1/issues/iss_1/comments', 'POST'],
		['/api/v1/issues/iss_1/transition', 'POST'],
		['/api/v1/issues/iss_1/prompt', 'GET'],
		['/api/v1/context', 'GET'],
		// Export is a read of what a run key can already list.
		['/api/v1/export', 'GET'],
		['/api/v1/library/validate', 'POST'],
		['/api/v1/library/prepare', 'POST'],
		['/api/v1/library/installs/lin_1', 'GET'],
		['/api/v1/events', 'GET'],
		['/api/v1/projects/prj_1/issues', 'GET'],
		// The vocabulary itself: an agent must know the terms to apply them,
		// and the launch prompt points at `tines labels list`.
		['/api/v1/labels', 'GET'],
		['/api/v1/labels', 'HEAD'],
		// The fleet's shape: an agent's own dispatch explainer already names
		// runners, their status and their caps (Tines/256).
		['/api/v1/runners', 'GET'],
		['/api/v1/runners', 'HEAD'],
		['/api/v1/runners/rnr_1', 'GET'],
		['/api/v1/supervisor/settings', 'GET'],
		['/api/v1/supervisor/settings', 'HEAD'],
		// The queue is unfenced by construction: the rule matches
		// `supervisor/settings`, not `supervisor/*`.
		['/api/v1/supervisor/queue', 'GET'],
		['/api/v1/supervisor/queue', 'HEAD'],
		// Methods arrive from the request verbatim; compare case-insensitively.
		['/api/v1/labels', 'get'],
		// Similar-looking but distinct segments stay open.
		['/api/v1/runnersandmore', 'GET'],
		['/api/v1/issues/resume', 'POST'],
		// Reading and working in a project stays open, archived or not.
		['/api/v1/projects/prj_1', 'GET'],
		['/api/v1/projects/prj_1/issues', 'POST'],
		['/api/v1/projects/prj_1/archived', 'POST']
	])('leaves %s %s open', (path, method) => {
		expect(isControlPlanePath(path, method)).toBe(false);
	});
});

describe('assertRunKeyAllowed', () => {
	const now = 1_723_000_000_000;
	const runKey = { agentRunId: 'arun_1', expiresAt: now + 60_000 };

	it('lets a live run key act on issue endpoints', () => {
		expect(() =>
			assertRunKeyAllowed(runKey, '/api/v1/issues/iss_1/comments', 'POST', now)
		).not.toThrow();
	});

	it('lets a live run key read the label library it is told to classify with', () => {
		expect(() => assertRunKeyAllowed(runKey, '/api/v1/labels', 'GET', now)).not.toThrow();
		expect(() => assertRunKeyAllowed(runKey, '/api/v1/labels', 'HEAD', now)).not.toThrow();
		// The fleet reads, opened with the Now row (Tines/256).
		expect(() => assertRunKeyAllowed(runKey, '/api/v1/runners', 'GET', now)).not.toThrow();
		expect(() =>
			assertRunKeyAllowed(runKey, '/api/v1/supervisor/settings', 'GET', now)
		).not.toThrow();
		expect(() => assertRunKeyAllowed(runKey, '/api/v1/supervisor/queue', 'GET', now)).not.toThrow();
	});

	it('403s a run key on every control-plane surface, naming the proposal convention', () => {
		for (const [path, method] of [
			['/api/v1/runners', 'POST'],
			['/api/v1/routing-rules/rul_1', 'PATCH'],
			['/api/v1/supervisor/settings', 'PUT'],
			['/api/v1/issues/iss_1/resume', 'POST'],
			['/api/v1/api-keys', 'GET'],
			['/api/v1/labels', 'POST'],
			['/api/v1/library/install', 'POST']
		]) {
			try {
				assertRunKeyAllowed(runKey, path, method, now);
				throw new Error(`expected a 403 for ${method} ${path}`);
			} catch (e) {
				expect(e).toBeInstanceOf(ApiFail);
				expect((e as ApiFail).status).toBe(403);
				expect((e as ApiFail).code).toBe('run_key_forbidden');
				expect((e as ApiFail).message).toContain('Context change:');
			}
		}
	});

	it('says what is forbidden about labels: minting terms, not reading them', () => {
		try {
			assertRunKeyAllowed(runKey, '/api/v1/labels', 'POST', now);
			throw new Error('expected a 403');
		} catch (e) {
			const message = (e as ApiFail).message;
			expect(message).toContain('create, rename, or delete labels');
			expect(message).not.toContain('the label library');
		}
	});

	it('401s an expired run key everywhere, before the fence', () => {
		const expired = { agentRunId: 'arun_1', expiresAt: now - 1 };
		for (const path of [
			'/api/v1/issues/iss_1/comments',
			'/api/v1/supervisor/settings',
			// Even the newly readable library: expiry is checked before the fence.
			'/api/v1/labels'
		]) {
			try {
				assertRunKeyAllowed(expired, path, 'GET', now);
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
		expect(() =>
			assertRunKeyAllowed(named, '/api/v1/supervisor/settings', 'PATCH', now)
		).not.toThrow();
		expect(() => assertRunKeyAllowed(named, '/api/v1/runners', 'POST', now)).not.toThrow();
		expect(() => assertRunKeyAllowed(named, '/api/v1/labels', 'POST', now)).not.toThrow();
	});
});

describe('jsonifyMethodNotAllowed', () => {
	/** What SvelteKit itself returns for an unsupported verb on a real route. */
	const kit405 = () =>
		new Response('PUT method not allowed', {
			status: 405,
			headers: { allow: 'GET, POST, HEAD' }
		});

	it("re-clothes Kit's bare 405 in the error envelope", async () => {
		const res = jsonifyMethodNotAllowed('/api/v1/projects', 'PUT', kit405());
		expect(res.status).toBe(405);
		expect(res.headers.get('content-type')).toContain('application/json');
		expect(await res.json()).toEqual({
			error: { code: 'method_not_allowed', message: 'PUT is not allowed on this resource' }
		});
	});

	it("carries Kit's Allow header over (RFC 9110 15.5.6)", () => {
		expect(jsonifyMethodNotAllowed('/api/v1/projects', 'PUT', kit405()).headers.get('allow')).toBe(
			'GET, POST, HEAD'
		);
	});

	it('names the method that was refused', async () => {
		const res = jsonifyMethodNotAllowed('/api/v1/issues/iss_1/comments', 'PATCH', kit405());
		expect((await res.json()).error.message).toBe('PATCH is not allowed on this resource');
	});

	it('leaves non-405 responses alone', async () => {
		const ok = new Response('hello', { status: 200 });
		expect(jsonifyMethodNotAllowed('/api/v1/projects', 'GET', ok)).toBe(ok);
	});

	it('leaves pages and non-API paths alone: only the API promises the envelope', () => {
		const html = kit405();
		expect(jsonifyMethodNotAllowed('/issues', 'PUT', html)).toBe(html);
		expect(jsonifyMethodNotAllowed('/api/auth/callback', 'PUT', html)).toBe(html);
	});

	it('leaves a handler-built 405 alone', async () => {
		// errorResponse() output is already the envelope; rewriting it would
		// throw away the handler's own code and message.
		const own = errorResponse(new ApiFail(405, 'wrong_verb', 'Use POST instead'));
		const res = jsonifyMethodNotAllowed('/api/v1/projects', 'PUT', own);
		expect(res).toBe(own);
		expect((await res.json()).error.code).toBe('wrong_verb');
	});
});

describe('readArchived', () => {
	const read = (qs: string) => readArchived(new URLSearchParams(qs));

	it('defaults to hiding archived rows', () => {
		expect(read('')).toBe('false');
		expect(read('archived=')).toBe('false');
	});

	it('accepts the three documented values', () => {
		expect(read('archived=true')).toBe('true');
		expect(read('archived=false')).toBe('false');
		expect(read('archived=all')).toBe('all');
	});

	it('422s anything else rather than silently defaulting', () => {
		try {
			read('archived=yes');
			throw new Error('expected a 422');
		} catch (e) {
			expect(e).toBeInstanceOf(ApiFail);
			expect((e as ApiFail).code).toBe('invalid_field');
			expect((e as ApiFail).details).toEqual({ field: 'archived' });
		}
	});
});

describe('workflow package read-only run-key paths', () => {
	it.each([
		['/api/v1/workflows/wf_standard/export', 'GET'],
		['/api/v1/library/validate', 'POST'],
		['/api/v1/library/prepare', 'POST']
	])('permits %s %s without opening whole-library import', (path, method) => {
		expect(() =>
			assertRunKeyAllowed({ agentRunId: 'run', expiresAt: Date.now() + 60_000 }, path, method)
		).not.toThrow();
		expect(isControlPlanePath('/api/v1/import', 'POST')).toBe(true);
	});
});
