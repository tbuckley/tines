/**
 * Route-level trigger wiring for the label routes. A label is a routing-rule
 * dimension, so gaining one can create a match and losing one can remove it —
 * but the engine's own tests never reach these handlers, and a missing
 * `queueDispatchPass` there is invisible to them.
 */
import { describe, expect, it } from 'vitest';
import { createTestDb } from '$lib/server/api/test-db';
import {
	addIssue,
	addLabel,
	addRule,
	addRunner,
	runs,
	seedBase,
	setSettings,
	USER
} from '$lib/server/supervisor/test-fixtures';
import { POST } from './+server';
import { DELETE } from './[labelRef]/+server';

/** A world where the only routing rule turns on the `docs` label. */
function seedLabelRouting() {
	const t = createTestDb();
	seedBase(t);
	setSettings(t);
	// The route's pass runs on the wall clock, so liveness must be real.
	const runner = addRunner(t, { lastSeen: Date.now() });
	const docs = addLabel(t, 'docs');
	addRule(t, { label: docs, targets: [{ runner_id: runner }] });
	return { t, docs };
}

function labelEvent(t: ReturnType<typeof createTestDb>, path: string, method: string) {
	const waits: Promise<unknown>[] = [];
	const url = new URL(`http://test${path}`);
	return {
		waits,
		event: {
			locals: { user: { id: USER, name: 'alice' } },
			platform: { env: t.env, ctx: { waitUntil: (p: Promise<unknown>) => waits.push(p) } },
			request: new Request(url, {
				method,
				headers: { 'content-type': 'application/json' },
				body: method === 'POST' ? JSON.stringify({ labels: ['docs'] }) : undefined
			}),
			url
		}
	};
}

describe('the issue-label routes', () => {
	it('dispatches an issue that has just gained the label a rule routes on', async () => {
		const { t } = seedLabelRouting();
		const issue = addIssue(t);
		// Unlabelled, it matches nothing: any run below is the label's doing.
		expect(runs(t)).toHaveLength(0);

		const { event, waits } = labelEvent(t, `/api/v1/issues/${issue}/labels`, 'POST');
		const res = await POST({ ...event, params: { id: issue } } as unknown as Parameters<
			typeof POST
		>[0]);
		expect(res.status).toBe(200);

		expect(waits).toHaveLength(1);
		await Promise.all(waits);
		expect(runs(t).map((r) => r.issue_id)).toEqual([issue]);
	});

	it('schedules a pass when a label is removed, since a match can disappear', async () => {
		const { t, docs } = seedLabelRouting();
		const issue = addIssue(t, { labels: [docs] });

		const { event, waits } = labelEvent(t, `/api/v1/issues/${issue}/labels/docs`, 'DELETE');
		const res = await DELETE({
			...event,
			params: { id: issue, labelRef: 'docs' }
		} as unknown as Parameters<typeof DELETE>[0]);
		expect(res.status).toBe(204);

		expect(waits).toHaveLength(1);
		await Promise.all(waits);
		// The label is gone, so the rule no longer matches and nothing ran.
		expect(runs(t)).toHaveLength(0);
	});
});
