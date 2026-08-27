/**
 * Route-level trigger wiring: the engine's internals are unit-tested in
 * lib/server/supervisor, but a missed `queueDispatchPass` call in a route is
 * invisible there. This drives a real handler end to end against the test
 * harness and asserts the opportunistic pass actually ran — unblocking an
 * issue over the API dispatches it via the captured waitUntil promise.
 */
import { describe, expect, it } from 'vitest';
import { createTestDb } from '$lib/server/api/test-db';
import { loadEligibleIssues } from '$lib/server/supervisor/engine';
import {
	addIssue,
	addRule,
	addRunner,
	NOW,
	REVIEW,
	runs,
	seedBase,
	setSettings,
	USER
} from '$lib/server/supervisor/test-fixtures';
import { DELETE } from './+server';

describe('DELETE /api/v1/issues/:id/links/:linkId', () => {
	it('schedules an opportunistic dispatch pass after removing a blocking link', async () => {
		const t = createTestDb();
		seedBase(t);
		setSettings(t);
		// The route's pass runs on the wall clock, so liveness must be real.
		const runner = addRunner(t, { lastSeen: Date.now() });
		addRule(t, { targets: [{ runner_id: runner }] });
		const blocked = addIssue(t);
		const blocker = addIssue(t, { state: REVIEW });
		t.sqlite
			.prepare(
				`INSERT INTO issue_link (id, source_issue_id, target_issue_id, kind, created_at) VALUES ('lnk_1', ?, ?, 'blocks', ${NOW})`
			)
			.run(blocker, blocked);
		expect(await loadEligibleIssues(t.db, USER)).toHaveLength(0);

		// waitUntil promises are captured so the pass can be awaited.
		const waits: Promise<unknown>[] = [];
		const event = {
			params: { id: blocked, linkId: 'lnk_1' },
			locals: { user: { id: USER, name: 'alice' } },
			platform: { env: t.env, ctx: { waitUntil: (p: Promise<unknown>) => waits.push(p) } },
			request: new Request(`http://test/api/v1/issues/${blocked}/links/lnk_1`, { method: 'DELETE' }),
			url: new URL(`http://test/api/v1/issues/${blocked}/links/lnk_1`)
		};
		const res = await DELETE(event as unknown as Parameters<typeof DELETE>[0]);
		expect(res.status).toBe(204);

		// The route scheduled exactly one pass, and it dispatched the issue
		// (poll-mode local adapter: the claim lands as `assigned`).
		expect(waits).toHaveLength(1);
		await Promise.all(waits);
		expect(runs(t)).toHaveLength(1);
		expect(runs(t)[0].issue_id).toBe(blocked);
		expect(runs(t)[0].status).toBe('assigned');
	});
});
