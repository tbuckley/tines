import { beforeEach, describe, expect, it } from 'vitest';
import { sha256Hex } from '$lib/server/crypto';
import { createTestDb, type TestDb } from '$lib/server/api/test-db';
import {
	addIssue,
	addRun,
	addRunKey,
	addRunner,
	seedBase,
	USER
} from '$lib/server/supervisor/test-fixtures';
import { GET as cases } from './cases/+server';
import { GET as reports } from './cases/[snapshotId]/reports/+server';
import { POST as read } from './cases/[snapshotId]/read/+server';
import { POST as decisions } from './decisions/+server';
import { GET as publishers } from './publishers/+server';
import { GET as snapshot } from './snapshots/[snapshotId]/+server';
import { GET as audit } from './snapshots/[snapshotId]/audit/+server';

const SNAPSHOT = 'snapshot_12345678901234567890';
const SECRET_MARKER = 'reporter-private-marker';
let t: TestDb;

type Handler = (event: never) => Promise<Response>;

const routes: Array<{ path: string; method: 'GET' | 'POST'; handler: Handler; body?: object }> = [
	{ path: '/cases', method: 'GET', handler: cases as Handler },
	{ path: `/cases/${SNAPSHOT}/reports`, method: 'GET', handler: reports as Handler },
	{
		path: `/cases/${SNAPSHOT}/read`,
		method: 'POST',
		handler: read as Handler,
		body: { through_version: 1 }
	},
	{
		path: '/decisions',
		method: 'POST',
		handler: decisions as Handler,
		body: {
			request_id: '123e4567-e89b-42d3-a456-426614174000',
			action: 'disable',
			target: { snapshot_id: SNAPSHOT },
			reason: SECRET_MARKER
		}
	},
	{ path: '/publishers', method: 'GET', handler: publishers as Handler },
	{ path: `/snapshots/${SNAPSHOT}`, method: 'GET', handler: snapshot as Handler },
	{ path: `/snapshots/${SNAPSHOT}/audit`, method: 'GET', handler: audit as Handler }
];

function event(
	route: (typeof routes)[number],
	options: { userId?: string; bearer?: string; search?: string } = {}
) {
	const url = new URL(
		`http://test/api/v1/host/workflow-moderation${route.path}${options.search ?? ''}`
	);
	const headers = new Headers();
	if (route.method === 'POST') {
		headers.set('origin', url.origin);
		headers.set('content-type', 'application/json');
	}
	if (options.bearer) headers.set('authorization', `Bearer ${options.bearer}`);
	return {
		locals: options.userId ? { user: { id: options.userId, name: 'Browser user' } } : {},
		platform: { env: t.env, ctx: { waitUntil: () => {} } },
		params: { snapshotId: SNAPSHOT },
		url,
		request: new Request(url, {
			method: route.method,
			headers,
			body: route.body ? JSON.stringify(route.body) : undefined
		})
	};
}

beforeEach(() => {
	t = createTestDb();
	seedBase(t);
	t.env.PUBLIC_WORKFLOW_MODERATOR_USER_IDS = USER;
	t.env.PUBLIC_WORKFLOW_REPORT_HMAC_SECRET = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
});

describe('host moderation route boundary', () => {
	it('denies every route to ordinary sessions before returning host data', async () => {
		for (const route of routes) {
			const response = await route.handler(event(route, { userId: 'ordinary_user' }) as never);
			expect(response.status, route.path).toBe(403);
			expect(await response.text(), route.path).not.toContain(SECRET_MARKER);
		}
	});

	it('denies every route to run keys even when their account is a configured moderator', async () => {
		const runId = addRun(t, {
			issueId: addIssue(t),
			runnerId: addRunner(t),
			status: 'running',
			startedAt: Date.now()
		});
		const keyId = addRunKey(t, runId);
		const bearer = 'moderator-run-secret';
		t.sqlite
			.prepare('UPDATE api_key SET key_hash = ? WHERE id = ?')
			.run(await sha256Hex(bearer), keyId);
		for (const route of routes) {
			const response = await route.handler(event(route, { bearer }) as never);
			expect(response.status, route.path).toBe(403);
			expect(await response.text(), route.path).not.toContain(SECRET_MARKER);
		}
	});

	it('returns private no-store envelopes without leaking reporter or account identifiers', async () => {
		for (const route of routes) {
			const response = await route.handler(event(route, { userId: USER }) as never);
			expect([200, 404], route.path).toContain(response.status);
			expect(response.headers.get('cache-control'), route.path).toBe('no-store, max-age=0');
			const text = await response.text();
			expect(text, route.path).not.toContain('a@example.com');
			expect(text, route.path).not.toContain('ordinary_user');
		}
	});

	it('forwards publisher, receipt, and audit cursors through their HTTP routes', async () => {
		t.sqlite.exec(`INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt)
			VALUES ('publisher_a', 'A', 'publisher-a@example.test', 1, 1, 1),
			       ('publisher_b', 'B', 'publisher-b@example.test', 1, 1, 1)`);
		t.sqlite
			.prepare(
				`INSERT INTO workflow_publisher_status
				 (user_id, suspended, status_version) VALUES (?, 1, 1), (?, 1, 1)`
			)
			.run('publisher_a', 'publisher_b');
		t.sqlite
			.prepare(
				`INSERT INTO workflow_report_case
				 (snapshot_id, version, latest_report_at, updated_at) VALUES (?, 2, 20, 20)`
			)
			.run(SNAPSHOT);
		const noteHash = 'a'.repeat(64);
		const insertReport = t.sqlite.prepare(
			`INSERT INTO workflow_report
			 (id, snapshot_id, case_version, reason, note, note_hash, created_at)
			 VALUES (?, ?, ?, 'other', 'same', ?, ?)`
		);
		insertReport.run('rpt_route_a', SNAPSHOT, 1, noteHash, 10);
		insertReport.run('rpt_route_b', SNAPSHOT, 2, noteHash, 20);
		const insertAudit = t.sqlite.prepare(
			`INSERT INTO workflow_moderation_audit
			 (id, request_id, request_hash, actor_user_id, actor_name, action, target_kind,
			  target_id, snapshot_id, before_json, after_json, reason, created_at, expires_at)
			 VALUES (?, ?, 'hash', ?, 'Moderator', 'dismiss', 'snapshot', ?, ?, '{}', '{}',
			  'reviewed', ?, 999999)`
		);
		insertAudit.run('mod_route_a', 'request_route_a', USER, SNAPSHOT, SNAPSHOT, 10);
		insertAudit.run('mod_route_b', 'request_route_b', USER, SNAPSHOT, SNAPSHOT, 20);

		const publisherRoute = routes.find((route) => route.path === '/publishers')!;
		const firstPublishers = await publisherRoute.handler(
			event(publisherRoute, { userId: USER, search: '?limit=1' }) as never
		);
		const firstPublisherBody = (await firstPublishers.json()) as {
			items: Array<{ publisher_id: string }>;
			next_cursor: string;
		};
		const secondPublishers = await publisherRoute.handler(
			event(publisherRoute, {
				userId: USER,
				search: `?limit=1&cursor=${firstPublisherBody.next_cursor}`
			}) as never
		);
		const secondPublisherBody = (await secondPublishers.json()) as {
			items: Array<{ publisher_id: string }>;
		};
		expect([
			firstPublisherBody.items[0].publisher_id,
			secondPublisherBody.items[0].publisher_id
		]).toEqual(['publisher_a', 'publisher_b']);

		const reportRoute = routes.find((route) => route.path.includes('/reports'))!;
		const reportQuery = `reason=other&note_hash=${noteHash}&limit=1`;
		const firstReports = await reportRoute.handler(
			event(reportRoute, { userId: USER, search: `?${reportQuery}` }) as never
		);
		const firstReportBody = (await firstReports.json()) as {
			items: Array<{ reference: string }>;
			next_cursor: string;
		};
		const secondReports = await reportRoute.handler(
			event(reportRoute, {
				userId: USER,
				search: `?${reportQuery}&cursor=${firstReportBody.next_cursor}`
			}) as never
		);
		const secondReportBody = (await secondReports.json()) as {
			items: Array<{ reference: string }>;
		};
		expect([firstReportBody.items[0].reference, secondReportBody.items[0].reference]).toEqual([
			'rpt_route_b',
			'rpt_route_a'
		]);

		const auditRoute = routes.find((route) => route.path.endsWith('/audit'))!;
		const firstAudits = await auditRoute.handler(
			event(auditRoute, { userId: USER, search: '?limit=1' }) as never
		);
		const firstAuditBody = (await firstAudits.json()) as {
			items: Array<{ id: string }>;
			next_cursor: string;
		};
		const secondAudits = await auditRoute.handler(
			event(auditRoute, {
				userId: USER,
				search: `?limit=1&cursor=${firstAuditBody.next_cursor}`
			}) as never
		);
		const secondAuditBody = (await secondAudits.json()) as { items: Array<{ id: string }> };
		expect([firstAuditBody.items[0].id, secondAuditBody.items[0].id]).toEqual([
			'mod_route_b',
			'mod_route_a'
		]);
	});
});
