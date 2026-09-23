/**
 * The transfer endpoint at the wire. The service is unit-tested elsewhere; what
 * only these tests can see is the route: that the destination comes off
 * `?project=`, that a missing one is a 422 rather than a 500, that the POST
 * body is validated, and that GET → POST is a real round trip through the
 * handlers a client actually calls.
 */
import type { IssueTransferPreview, IssueTransferResult } from '@tines/shared';
import { describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from '$lib/server/api/test-db';
import { NOW, PROJECT, USER, addIssue, seedBase } from '$lib/server/supervisor/test-fixtures';
import { GET, POST } from './+server';

const DESTINATION = 'prj_transfer_dest';

function seed(): { t: TestDb; issueId: string } {
	const t = createTestDb();
	t.env.BETTER_AUTH_SECRET = 'route-transfer-secret';
	seedBase(t);
	t.sqlite.exec(`
		INSERT INTO project (id, user_id, name, created_at, updated_at)
		VALUES ('${DESTINATION}', '${USER}', 'destination', ${NOW}, ${NOW});
	`);
	const issueId = addIssue(t, { id: 'iss_route_transfer', title: 'Move me' });
	return { t, issueId };
}

function routeEvent(
	t: TestDb,
	path: string,
	params: { id: string },
	body?: unknown,
	waits: Promise<unknown>[] = []
) {
	const url = new URL(`http://test${path}`);
	return {
		locals: { user: { id: USER, name: 'alice' } },
		platform: {
			env: t.env,
			ctx: { waitUntil: (promise: Promise<unknown>) => waits.push(promise) }
		},
		request: body
			? new Request(url, {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify(body)
				})
			: new Request(url),
		params,
		url
	} as unknown as Parameters<typeof GET>[0];
}

describe('the issue transfer route', () => {
	it('previews the destination named by ?project and commits its token', async () => {
		const { t, issueId } = seed();
		const waits: Promise<unknown>[] = [];
		const preview = (await (
			await GET(
				routeEvent(t, `/api/v1/issues/${issueId}/transfer?project=${DESTINATION}`, { id: issueId })
			)
		).json()) as IssueTransferPreview;
		expect(preview).toMatchObject({
			issue_id: issueId,
			new_ref: null,
			can_commit: true,
			destination: { id: DESTINATION, name: 'destination' }
		});
		// A preview writes nothing at all, least of all a number.
		expect(t.sqlite.prepare(`SELECT COUNT(*) c FROM issue_address`).get()).toEqual({ c: 1 });

		const result = (await (
			await POST(
				routeEvent(
					t,
					`/api/v1/issues/${issueId}/transfer`,
					{ id: issueId },
					{
						project_id: DESTINATION,
						preview_token: preview.preview_token
					},
					waits
				)
			)
		).json()) as IssueTransferResult;
		expect(result).toMatchObject({
			status: 'transferred',
			issue_id: issueId,
			old_ref: { project_id: PROJECT, number: preview.old_ref.number },
			new_ref: { project_name: 'destination' }
		});
		expect(result.issue_path).toBe(`/issues/destination/${result.new_ref.number}`);
		expect(waits).toHaveLength(1);
		await Promise.all(waits);
	});

	it('rejects a preview with no destination and a body with no token', async () => {
		const { t, issueId } = seed();
		const noProject = await GET(
			routeEvent(t, `/api/v1/issues/${issueId}/transfer`, { id: issueId })
		);
		expect(noProject.status).toBe(422);
		expect(await noProject.json()).toMatchObject({ error: { code: 'invalid_field' } });
		const noToken = await POST(
			routeEvent(
				t,
				`/api/v1/issues/${issueId}/transfer`,
				{ id: issueId },
				{
					project_id: DESTINATION
				}
			)
		);
		expect(noToken.status).toBe(422);
	});
});
