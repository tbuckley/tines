import { describe, expect, it } from 'vitest';
import { withLibraryDocumentDigest } from '@tines/shared';
import {
	automatedPackage,
	inheritedPackage
} from '../../../../../../packages/shared/src/library/fixtures';
import { createTestDb } from '../api/test-db';
import { USER, PROJECT, seedBase, addRunner } from '../supervisor/test-fixtures';
import { packagePlanDigest, prepareWorkflowPackage, reconstructPackagePlan } from './plan';
import {
	verifyPackagePlan,
	signPackagePlan,
	validatePackageAllocation,
	PACKAGE_PLAN_TTL_MS
} from './token';
import { readPackageDestination } from './destination';

const actor = {
	userId: USER,
	userName: 'Alice',
	apiKeyId: null,
	apiKeyName: null,
	viaSession: true
};
const env = { BETTER_AUTH_SECRET: 'unit-test-signing-material' };
async function fixture() {
	const t = createTestDb();
	seedBase(t);
	const document = await withLibraryDocumentDigest(inheritedPackage());
	const raw = JSON.stringify(document);
	const choices = { inputs: { 'input:1': { mode: 'create', name: 'qa', color: 'blue' } } };
	return {
		t,
		document,
		raw,
		choices,
		prepare: () => prepareWorkflowPackage(t.db, env, actor, raw, choices)
	};
}
async function automatedFixture() {
	const t = createTestDb();
	seedBase(t);
	const runner = addRunner(t, { type: 'local', config: { harness: 'codex' } });
	t.sqlite
		.prepare('INSERT INTO routing_rule(id,user_id,targets,created_at,updated_at) VALUES(?,?,?,1,1)')
		.run('global', USER, JSON.stringify([{ runner_id: runner }]));
	const document = await withLibraryDocumentDigest(automatedPackage());
	const raw = JSON.stringify(document);
	const choices = {
		inputs: {
			'input:1': { mode: 'create' as const, name: 'qa', color: 'blue' as const },
			'input:2': { mode: 'reuse' as const, id: PROJECT }
		},
		schedule_ids: ['schedule:1'],
		routing: { 'routing:1': 'balanced' as const }
	};
	return {
		t,
		runner,
		document,
		raw,
		choices,
		prepare: () => prepareWorkflowPackage(t.db, env, actor, raw, choices)
	};
}
describe('signed workflow package preparation and reconstruction', () => {
	it('is read-only, returns complete content, budgets the receipt and signs a 15-minute replayable plan', async () => {
		const f = await fixture();
		const before = await readPackageDestination(f.t.db, USER);
		const preview = await f.prepare();
		const payload = await verifyPackagePlan(preview.plan_token, env.BETTER_AUTH_SECRET);
		expect(payload.expires_at - payload.issued_at).toBe(PACKAGE_PLAN_TTL_MS);
		expect(payload.actor_key).toBe(`session:${USER}`);
		expect(preview.document).toEqual(f.document);
		expect(preview.resolved.context).toHaveLength(3);
		expect(preview.budget.statements).toBe(20);
		expect((await readPackageDestination(f.t.db, USER)).raw).toBe(before.raw);
		expect(await f.t.db.selectFrom('event').selectAll().execute()).toEqual([]);
		const replay = await reconstructPackagePlan(f.t.db, actor, f.raw, payload);
		expect(replay.resolved).toEqual(preview.resolved);
	});
	it('preserves explicit/proposed name combinations across canonical key ordering', async () => {
		const f = await fixture();
		const preview = await prepareWorkflowPackage(f.t.db, env, actor, f.raw, {
			...f.choices,
			workflow_names: { 'workflow:2': 'Reviewer' }
		});
		const payload = await verifyPackagePlan(preview.plan_token, env.BETTER_AUTH_SECRET);
		expect((await reconstructPackagePlan(f.t.db, actor, f.raw, payload)).resolved).toEqual(
			preview.resolved
		);
	});
	it('binds account and exact actor identity; run keys may prepare but another actor must reprepare', async () => {
		const f = await fixture();
		const runActor = { ...actor, viaSession: false, apiKeyId: 'run-key', agentRunId: 'run' };
		const preview = await prepareWorkflowPackage(f.t.db, env, runActor, f.raw, f.choices);
		const payload = await verifyPackagePlan(preview.plan_token, env.BETTER_AUTH_SECRET);
		await expect(reconstructPackagePlan(f.t.db, actor, f.raw, payload)).rejects.toMatchObject({
			status: 403
		});
		await expect(
			reconstructPackagePlan(f.t.db, { ...runActor, userId: 'other' }, f.raw, payload)
		).rejects.toMatchObject({ status: 403 });
		expect(
			(await reconstructPackagePlan(f.t.db, runActor, f.raw, payload)).resolved.inputs[0].mode
		).toBe('create');
	});
	it('stales on phantom workflow or label names even though workflow names have no uniqueness constraint', async () => {
		for (const kind of ['workflow', 'label']) {
			const f = await fixture();
			const preview = await f.prepare();
			const payload = await verifyPackagePlan(preview.plan_token, env.BETTER_AUTH_SECRET);
			if (kind === 'workflow')
				f.t.sqlite.exec(
					`INSERT INTO workflow(id,user_id,name,description,initial_state_id,created_at,updated_at) VALUES('competitor','${USER}','Reviewer','','wfs_std_open',1,1)`
				);
			else
				f.t.sqlite.exec(
					`INSERT INTO label(id,user_id,name,color,description,created_at,updated_at) VALUES('competitor','${USER}','QA','blue','',1,1)`
				);
			await expect(reconstructPackagePlan(f.t.db, actor, f.raw, payload)).rejects.toMatchObject({
				status: 409,
				code: 'plan_stale'
			});
		}
	});
	it('ignores unrelated project, label and workflow edits', async () => {
		const f = await fixture();
		const preview = await f.prepare();
		const payload = await verifyPackagePlan(preview.plan_token, env.BETTER_AUTH_SECRET);
		f.t.sqlite.exec(
			`UPDATE project SET name='Renamed' WHERE id='${PROJECT}'; INSERT INTO label(id,user_id,name,color,description,created_at,updated_at) VALUES('other','${USER}','unrelated','blue','',1,1); UPDATE workflow SET description='Different system text' WHERE id='wf_standard'`
		);
		expect((await reconstructPackagePlan(f.t.db, actor, f.raw, payload)).resolved).toEqual(
			preview.resolved
		);
	});
	it('binds the file while ignoring authoritative-source edits and JSON key order', async () => {
		const f = await fixture();
		const preview = await f.prepare();
		const payload = await verifyPackagePlan(preview.plan_token, env.BETTER_AUTH_SECRET);
		const pretty = JSON.stringify(f.document, null, 2);
		expect((await reconstructPackagePlan(f.t.db, actor, pretty, payload)).document.digest).toBe(
			f.document.digest
		);
		const changed = structuredClone(f.document);
		changed.workflows[0].description += ' Changed';
		const changedRaw = JSON.stringify(await withLibraryDocumentDigest(changed));
		await expect(reconstructPackagePlan(f.t.db, actor, changedRaw, payload)).rejects.toMatchObject({
			code: 'package_changed'
		});
	});
	it('rejects expired or incompatible plans on replay but permits verified expiry for later receipt recovery', async () => {
		const f = await fixture();
		const preview = await f.prepare();
		const payload = await verifyPackagePlan(preview.plan_token, env.BETTER_AUTH_SECRET);
		payload.issued_at = 1;
		payload.expires_at = 1 + PACKAGE_PLAN_TTL_MS;
		const expired = await signPackagePlan(payload, env.BETTER_AUTH_SECRET);
		expect((await verifyPackagePlan(expired, env.BETTER_AUTH_SECRET)).expires_at).toBe(
			payload.expires_at
		);
		await expect(reconstructPackagePlan(f.t.db, actor, f.raw, payload)).rejects.toMatchObject({
			code: 'plan_stale'
		});
	});
	it('refuses altered signatures, keys, versions, oversized tokens and unavailable signing material', async () => {
		const f = await fixture();
		const preview = await f.prepare();
		const [prefix, body, signature] = preview.plan_token.split('.');
		for (const token of [
			`${prefix}.${body}x.${signature}`,
			`${prefix}.${body}.${signature.slice(1)}`,
			`other.${body}.${signature}`,
			'x'.repeat(800000)
		])
			await expect(verifyPackagePlan(token, env.BETTER_AUTH_SECRET)).rejects.toMatchObject({
				code: 'invalid_plan_token'
			});
		await expect(verifyPackagePlan(preview.plan_token, 'wrong-key')).rejects.toMatchObject({
			code: 'invalid_plan_token'
		});
		await expect(prepareWorkflowPackage(f.t.db, {}, actor, f.raw, f.choices)).rejects.toMatchObject(
			{ status: 503 }
		);
	});
	it('detects a changed resolved choice even if an internal caller signs it without recomputing the plan digest', async () => {
		const f = await fixture();
		const preview = await f.prepare();
		const payload = await verifyPackagePlan(preview.plan_token, env.BETTER_AUTH_SECRET);
		payload.choices.inputs!['input:1'] = { mode: 'create', name: 'different', color: 'red' };
		await expect(reconstructPackagePlan(f.t.db, actor, f.raw, payload)).rejects.toMatchObject({
			code: 'plan_stale'
		});
	});
	it('rejects malformed nested choices and allocations before signing', async () => {
		const f = await fixture();
		const preview = await f.prepare();
		const payload = await verifyPackagePlan(preview.plan_token, env.BETTER_AUTH_SECRET);
		for (const mutate of [
			(p: Record<string, any>) => {
				p.choices.inputs['input:1'] = { mode: 'create', name: 'qa', color: 'blue', extra: true };
			},
			(p: Record<string, any>) => {
				p.choices.schedule_ids = ['schedule:1', 'schedule:1'];
			},
			(p: Record<string, any>) => {
				p.allocation.records['state:1'].event_id = 42;
			},
			(p: Record<string, any>) => {
				p.allocation.labels['input:1'].extra = true;
			},
			(p: Record<string, any>) => {
				p.selection.schedules = [{ project_id: PROJECT, name: 'Daily', extra: true }];
			}
		]) {
			const malformed = structuredClone(payload) as unknown as Record<string, any>;
			mutate(malformed);
			await expect(
				signPackagePlan(malformed as never, env.BETTER_AUTH_SECRET)
			).rejects.toMatchObject({
				code: 'invalid_plan'
			});
		}
	});
	it('rejects document-mismatched allocations independently of the plan digest', async () => {
		const f = await fixture();
		const preview = await f.prepare();
		const payload = await verifyPackagePlan(preview.plan_token, env.BETTER_AUTH_SECRET);
		const original = await reconstructPackagePlan(f.t.db, actor, f.raw, payload);
		const changed = structuredClone(payload);
		changed.allocation.records.unknown = {
			id: 'wf_0123456789abcdef',
			event_id: 'evt_0123456789abcdef'
		};
		const { plan_digest: _oldDigest, ...unsigned } = changed;
		changed.plan_digest = await packagePlanDigest(unsigned, original.resolved);
		const token = await signPackagePlan(changed, env.BETTER_AUTH_SECRET);
		const verified = await verifyPackagePlan(token, env.BETTER_AUTH_SECRET);
		await expect(reconstructPackagePlan(f.t.db, actor, f.raw, verified)).rejects.toMatchObject({
			code: 'invalid_plan_token'
		});
	});
	it('rejects unknown, missing, wrong-kind, mismatched-event and duplicate allocations', async () => {
		const f = await fixture();
		const preview = await f.prepare();
		const payload = await verifyPackagePlan(preview.plan_token, env.BETTER_AUTH_SECRET);
		for (const mutate of [
			(p: typeof payload) => {
				p.allocation.records.unknown = {
					id: 'wf_0123456789abcdef',
					event_id: 'evt_0123456789abcdef'
				};
			},
			(p: typeof payload) => {
				delete p.allocation.records['state:1'];
			},
			(p: typeof payload) => {
				p.allocation.records['state:1'].event_id = 'evt_0123456789abcdef';
			},
			(p: typeof payload) => {
				p.allocation.records['state:1'].id = p.allocation.records['state:2'].id;
			},
			(p: typeof payload) => {
				p.allocation.labels['input:1'].id = 'wf_0123456789abcdef';
			}
		]) {
			const changed = structuredClone(payload);
			mutate(changed);
			expect(() => validatePackageAllocation(f.document, changed.allocation)).toThrowError(
				expect.objectContaining({
					code: 'invalid_plan_token'
				})
			);
		}
	});
});

it('bounds coherent-read retries when a reviewed label changes between every snapshot', async () => {
	const f = await fixture();
	f.t.sqlite.exec(
		`INSERT INTO label(id,user_id,name,color,description,created_at,updated_at) VALUES('qa','${USER}','qa','blue','',1,1)`
	);
	let reads = 0;
	const db = f.t.db.withPlugin({
		transformQuery: (args) => args.node,
		transformResult: async (args) => {
			if (args.result.rows.some((r) => Object.hasOwn(r as object, 'projection'))) {
				reads++;
				f.t.sqlite.exec(`UPDATE label SET color='${reads % 2 ? 'red' : 'blue'}' WHERE id='qa'`);
			}
			return args.result;
		}
	});
	await expect(prepareWorkflowPackage(db, env, actor, f.raw, {})).rejects.toMatchObject({
		code: 'destination_unstable'
	});
	expect(reads).toBe(6);
});

it('witnesses a reused label color and all required workflow state definitions', async () => {
	for (const kind of ['label', 'workflow']) {
		const f = await fixture();
		let choices: unknown = f.choices;
		if (kind === 'label') {
			f.t.sqlite.exec(
				`INSERT INTO label(id,user_id,name,color,description,created_at,updated_at) VALUES('qa','${USER}','qa','blue','',1,1)`
			);
			choices = {};
		} else {
			f.document.inputs.push({
				id: 'required',
				key: 'required',
				type: 'workflow',
				label: 'Required workflow',
				description: '',
				default: 'Standard',
				required: true,
				required_states: ['Open']
			});
			f.raw = JSON.stringify(await withLibraryDocumentDigest(f.document));
		}
		const preview = await prepareWorkflowPackage(f.t.db, env, actor, f.raw, choices);
		const payload = await verifyPackagePlan(preview.plan_token, env.BETTER_AUTH_SECRET);
		if (kind === 'label') f.t.sqlite.exec("UPDATE label SET color='red' WHERE id='qa'");
		else f.t.sqlite.exec("UPDATE workflow_state SET category='done' WHERE id='wfs_std_open'");
		await expect(reconstructPackagePlan(f.t.db, actor, f.raw, payload)).rejects.toMatchObject({
			code: 'plan_stale'
		});
	}
});

it('witnesses absent schedule names and matching routing-rule insertions', async () => {
	for (const kind of ['schedule', 'routing'] as const) {
		const f = await automatedFixture();
		const preview = await f.prepare();
		const payload = await verifyPackagePlan(preview.plan_token, env.BETTER_AUTH_SECRET);
		if (kind === 'schedule')
			f.t.sqlite.exec(`
				INSERT INTO scheduled_task
					(id,project_id,name,title_template,description_template,workflow_id,cron,timezone,
					 require_all_closed,enabled,next_run_at,run_count,created_at,updated_at)
				VALUES ('phantom','${PROJECT}','Weekly review','','','wf_standard','0 9 * * 1','UTC',
					1,0,1,0,1,1)`);
		else
			f.t.sqlite
				.prepare(
					'INSERT INTO routing_rule(id,user_id,project_id,targets,created_at,updated_at) VALUES(?,?,?,?,1,1)'
				)
				.run('phantom', USER, PROJECT, JSON.stringify([{ runner_id: f.runner }]));
		await expect(reconstructPackagePlan(f.t.db, actor, f.raw, payload)).rejects.toMatchObject({
			code: 'plan_stale'
		});
	}
});

it('does not stale selected automation when unrelated schedules, rules or runners change', async () => {
	const f = await automatedFixture();
	const preview = await f.prepare();
	const payload = await verifyPackagePlan(preview.plan_token, env.BETTER_AUTH_SECRET);
	f.t.sqlite.exec(`
		INSERT INTO scheduled_task
			(id,project_id,name,title_template,description_template,workflow_id,cron,timezone,
			 require_all_closed,enabled,next_run_at,run_count,created_at,updated_at)
		VALUES ('other-schedule','${PROJECT}','Other schedule','','','wf_standard','0 10 * * 1','UTC',
			1,0,1,0,1,1);
		INSERT INTO label(id,user_id,name,color,description,created_at,updated_at)
		VALUES('other-label','${USER}','Other label','blue','',1,1);
		INSERT INTO routing_rule(id,user_id,label_id,targets,created_at,updated_at)
		VALUES('other-rule','${USER}','other-label','[]',1,1);
	`);
	addRunner(f.t, { id: 'other-runner', name: 'Other runner', type: 'local' });
	expect((await reconstructPackagePlan(f.t.db, actor, f.raw, payload)).resolved).toEqual(
		preview.resolved
	);
});
