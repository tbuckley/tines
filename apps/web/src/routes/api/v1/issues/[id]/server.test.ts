/**
 * The handoff opt-in, at the wire. `round` and `since_last_run` are absent from
 * `IssueDetail` unless the caller passes `{ round: true }`, so the three read
 * routes are the only thing standing between the derivation and a client — and
 * deleting that option from all three left the whole web suite green. These
 * tests drive the real handlers so the option cannot go missing silently; the
 * prompt route's case is AC 2 (`tines issues prompt <ref>` opens with the
 * steer), which nothing else exercises above `issueBlock`.
 */
import type { IssueDetail, LaunchPromptResponse } from '@tines/shared';
import { describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from '$lib/server/api/test-db';
import {
	ENG_STATES,
	NOW,
	PROJECT,
	USER,
	addComment,
	addEngineeringWorkflow,
	addIssue,
	addRun,
	addRunKey,
	addRunner,
	addTransitionEvent,
	seedBase
} from '$lib/server/supervisor/test-fixtures';
import { GET as getByRef } from '../../projects/[id]/issues/[number]/+server';
import { GET as getPrompt } from './prompt/+server';
import { GET as getIssue } from './+server';

const HOUR = 3_600_000;

/**
 * One issue back in Implementation after a human sent it there: a finished run
 * that took the issue to Human Review, then the human's move and comment. Both
 * halves of the handoff are non-empty on it.
 */
function seedSteeredIssue(t: TestDb): string {
	seedBase(t);
	addEngineeringWorkflow(t);
	const runnerId = addRunner(t, { name: 'macbook' });
	const issueId = addIssue(t, {
		workflow: 'wf_eng',
		state: ENG_STATES.impl,
		title: 'Ship the thing'
	});
	addRun(t, {
		id: 'arun_impl1',
		issueId,
		runnerId,
		status: 'completed',
		stateAtStart: ENG_STATES.impl,
		stateAtEnd: ENG_STATES.humanReview,
		outcome: 'advanced',
		createdAt: NOW + HOUR,
		startedAt: NOW + HOUR,
		endedAt: NOW + HOUR + 600_000
	});
	const keyId = addRunKey(t, 'arun_impl1');
	addTransitionEvent(t, {
		issueId,
		apiKeyId: keyId,
		at: NOW + HOUR + 600_000,
		from: ENG_STATES.impl,
		to: ENG_STATES.humanReview,
		action: 'Submit for human review',
		fromName: 'Implementation',
		toName: 'Human Review'
	});
	addComment(t, {
		issueId,
		body: 'Implementation — landed it.',
		apiKeyId: keyId,
		at: NOW + HOUR + 500_000,
		id: 'cmt_run'
	});
	// The human's steer: the move back, and what they said about it.
	t.sqlite
		.prepare(`UPDATE issue SET state_id = ?, state_entered_at = ? WHERE id = ?`)
		.run(ENG_STATES.impl, NOW + 2 * HOUR, issueId);
	addTransitionEvent(t, {
		issueId,
		apiKeyId: null,
		at: NOW + 2 * HOUR,
		from: ENG_STATES.humanReview,
		to: ENG_STATES.impl,
		action: 'Send back to implementation',
		fromName: 'Human Review',
		toName: 'Implementation'
	});
	addComment(t, {
		issueId,
		body: 'CI is red on the e2e job.',
		apiKeyId: null,
		at: NOW + 2 * HOUR + 1,
		id: 'cmt_human'
	});
	return issueId;
}

function routeEvent(t: TestDb, path: string, params: Record<string, string>) {
	const url = new URL(`http://test${path}`);
	return {
		locals: { user: { id: USER, name: 'alice' } },
		platform: { env: t.env, ctx: { waitUntil: () => {} } },
		request: new Request(url),
		params,
		url
	} as unknown as Parameters<typeof getIssue>[0];
}

describe('the issue read routes', () => {
	it('asks for the handoff on GET /issues/:id', async () => {
		const t = createTestDb();
		const issueId = seedSteeredIssue(t);
		const res = await getIssue(routeEvent(t, `/api/v1/issues/${issueId}`, { id: issueId }));
		const body = (await res.json()) as IssueDetail;
		// The keys exist at all only because the route opted in.
		expect('round' in body).toBe(true);
		expect(body.since_last_run?.transition?.action).toBe('Send back to implementation');
		expect(body.since_last_run?.comments.map((c) => c.id)).toEqual(['cmt_human']);
	});

	it('asks for the handoff on GET /projects/:id/issues/:number', async () => {
		const t = createTestDb();
		const issueId = seedSteeredIssue(t);
		const number = t.sqlite.prepare(`SELECT number FROM issue WHERE id = ?`).get(issueId) as {
			number: number;
		};
		const res = await getByRef(
			routeEvent(t, `/api/v1/projects/${PROJECT}/issues/${number.number}`, {
				id: PROJECT,
				number: String(number.number)
			})
		);
		const body = (await res.json()) as IssueDetail;
		expect('round' in body).toBe(true);
		expect('since_last_run' in body).toBe(true);
		expect(body.since_last_run?.transition?.from_state.name).toBe('Human Review');
	});

	it('opens the launch prompt with the human steer (AC 2)', async () => {
		const t = createTestDb();
		const issueId = seedSteeredIssue(t);
		const res = await getPrompt(
			routeEvent(t, `/api/v1/issues/${issueId}/prompt`, {
				id: issueId
			}) as unknown as Parameters<typeof getPrompt>[0]
		);
		const body = (await res.json()) as LaunchPromptResponse;
		expect(body.text).toContain('### Since the last run');
		expect(body.text).toContain('Moved from **Human Review** → Implementation');
		expect(body.text).toContain('CI is red on the e2e job.');
		expect(body.text.indexOf('### Since the last run')).toBeLessThan(
			body.text.indexOf('### Comments')
		);
	});
});
