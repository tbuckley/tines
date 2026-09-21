import { expect, it } from 'vitest';
import { createTestDb } from '$lib/server/api/test-db';
import {
	seedBase,
	addTwoStageWorkflow,
	addIssue,
	addTransitionEvent,
	STAGE_A,
	STAGE_B,
	NOW,
	USER
} from '$lib/server/supervisor/test-fixtures';
import { GET } from './+server';
import { sha256Hex } from '$lib/server/api/core';

async function addScopedKey(
	t: ReturnType<typeof createTestDb>,
	bearer: string,
	workspace: 'read' | 'none' = 'read',
	id = 'key_sent_back_scoped'
) {
	t.sqlite
		.prepare(
			`INSERT INTO api_key (id, user_id, name, key_hash, key_prefix, permissions, created_at)
			 VALUES (?, ?, 'sent-back', ?, 'tines_sent', ?, ?)`
		)
		.run(
			id,
			USER,
			await sha256Hex(bearer),
			JSON.stringify({
				version: 1,
				projects: { access: 'read', scope: ['prj_1'] },
				workspace,
				control_plane: 'read'
			}),
			NOW
		);
}

it('passes frozen evidence bounds through the route and rejects invalid inputs', async () => {
	const t = createTestDb();
	seedBase(t);
	addTwoStageWorkflow(t);
	const issue = addIssue(t, { state: STAGE_A, workflow: 'wf_two' });
	const until = NOW - 86400000;
	addTransitionEvent(t, { issueId: issue, at: until, from: STAGE_B, to: STAGE_A, apiKeyId: null });
	const get = (suffix: string) => {
		const url = new URL(`http://test/api/v1/supervisor/stats/sent-back?state=${STAGE_B}${suffix}`);
		return GET({
			locals: { user: { id: USER, name: 'alice' } },
			platform: { env: t.env, ctx: { waitUntil: () => {} } },
			request: new Request(url),
			url
		} as unknown as Parameters<typeof GET>[0]);
	};
	const frozen = await get(`&until=${until}`);
	expect(frozen.status).toBe(200);
	expect(await frozen.json()).toMatchObject({ window: { until }, items: [] });
	const later = await get(`&until=${until + 1}`);
	expect((await later.json()).items).toHaveLength(1);
	for (const invalid of ['', 'nan', 'Infinity', '-1', '1.5', String(Date.now() + 86400000)])
		expect((await get(`&until=${invalid}`)).status).toBe(422);
});

it('requires workspace read and filters sent-back evidence by project scope', async () => {
	const t = createTestDb();
	seedBase(t);
	addTwoStageWorkflow(t);
	t.sqlite.exec(
		`INSERT INTO project (id, user_id, name, created_at, updated_at)
		 VALUES ('prj_sent_back_other', '${USER}', 'other', ${NOW}, ${NOW})`
	);
	const visible = addIssue(t, { id: 'iss_sent_back_visible', state: STAGE_A, workflow: 'wf_two' });
	const hidden = addIssue(t, {
		id: 'iss_sent_back_hidden',
		state: STAGE_A,
		workflow: 'wf_two',
		project: 'prj_sent_back_other'
	});
	addTransitionEvent(t, {
		issueId: visible,
		apiKeyId: null,
		at: NOW - 1_000,
		from: STAGE_B,
		to: STAGE_A
	});
	addTransitionEvent(t, {
		issueId: hidden,
		apiKeyId: null,
		at: NOW - 900,
		from: STAGE_B,
		to: STAGE_A,
		project: 'prj_sent_back_other'
	});
	const bearer = 'sent-back-scoped-key';
	await addScopedKey(t, bearer);
	const get = (suffix = '', key = bearer) => {
		const url = new URL(`http://test/api/v1/supervisor/stats/sent-back?state=${STAGE_B}${suffix}`);
		return GET({
			locals: {},
			platform: { env: t.env, ctx: { waitUntil: () => {} } },
			request: new Request(url, { headers: { authorization: `Bearer ${key}` } }),
			url
		} as unknown as Parameters<typeof GET>[0]);
	};
	const filtered = await get(`&until=${NOW}`);
	expect(filtered.status).toBe(200);
	expect(await filtered.json()).toMatchObject({ items: [{ issue: { id: visible } }] });
	const explicitHidden = await get(`&project=prj_sent_back_other&until=${NOW}`);
	expect(explicitHidden.status).toBe(403);
	const controlOnlyBearer = 'sent-back-control-only-key';
	await addScopedKey(t, controlOnlyBearer, 'none', 'key_sent_back_control_only');
	expect((await get(`&until=${NOW}`, controlOnlyBearer)).status).toBe(403);
});
