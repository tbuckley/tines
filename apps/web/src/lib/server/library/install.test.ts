import { afterEach, describe, expect, it, vi } from 'vitest';
import { withLibraryDocumentDigest } from '@tines/shared';
import {
	automatedPackage,
	inheritedPackage
} from '../../../../../../packages/shared/src/library/fixtures';
import { createTestDb } from '../api/test-db';
import type { ActorContext } from '../api/core';
import { PROJECT, USER, addRunner, seedBase } from '../supervisor/test-fixtures';
import { getWorkflowPackageReceipt, installWorkflowPackage } from './install';
import { prepareWorkflowPackage } from './plan';
import { PACKAGE_PLAN_TTL_MS } from './token';

const actor: ActorContext = {
	userId: USER,
	userName: 'Alice',
	apiKeyId: null,
	apiKeyName: null,
	viaSession: true
};
const signing = { BETTER_AUTH_SECRET: 'unit-test-signing-material' };

async function fixture() {
	const t = createTestDb();
	seedBase(t);
	const document = await withLibraryDocumentDigest(inheritedPackage());
	const document_json = JSON.stringify(document);
	const preview = await prepareWorkflowPackage(t.db, signing, actor, document_json, {
		inputs: { 'input:1': { mode: 'create', name: 'qa', color: 'blue' } }
	});
	const request = {
		document_json,
		plan_token: preview.plan_token,
		confirmation: { plan_digest: preview.plan_digest }
	};
	return { t, document, preview, request };
}

afterEach(() => vi.useRealTimers());

describe('atomic workflow package install', () => {
	it('commits one guarded batch, links every created object, and retries from the receipt', async () => {
		const f = await fixture();
		const first = await installWorkflowPackage(
			f.t.db,
			{ ...f.t.env, ...signing },
			actor,
			f.request
		);
		expect(first.id).toBe(f.preview.plan_id);
		const createdIds = f.t
			.all(
				`
				SELECT id FROM workflow WHERE user_id='${USER}'
				UNION ALL SELECT s.id FROM workflow_state s JOIN workflow w ON w.id=s.workflow_id WHERE w.user_id='${USER}'
				UNION ALL SELECT tr.id FROM workflow_transition tr JOIN workflow w ON w.id=tr.workflow_id WHERE w.user_id='${USER}'
				UNION ALL SELECT id FROM context_item WHERE user_id='${USER}'
				UNION ALL SELECT f.id FROM context_item_file f JOIN context_item c ON c.id=f.context_item_id WHERE c.user_id='${USER}'
				UNION ALL SELECT id FROM label WHERE user_id='${USER}' AND name='qa' COLLATE NOCASE
			`
			)
			.map((row) => row.id)
			.sort();
		expect(first.objects.map((object) => object.id).sort()).toEqual(createdIds);
		expect(first.objects.map((object) => object.kind)).toEqual(
			expect.arrayContaining([
				'workflow',
				'state',
				'transition',
				'prompt',
				'skill',
				'file',
				'repo',
				'label'
			])
		);
		expect(first.objects.find((o) => o.relationship === 'main')).toMatchObject({
			name: f.preview.resolved.workflows.find((w) => w.id === f.document.main_workflow_id)!.name
		});
		expect(f.t.all('SELECT enabled,run_count FROM scheduled_task')).toEqual([]);
		expect(f.t.all('SELECT * FROM issue')).toEqual([]);
		expect(f.t.all('SELECT * FROM library_install')).toHaveLength(1);
		expect(f.t.all('SELECT * FROM event')).toHaveLength(6);

		vi.setSystemTime(Date.now() + PACKAGE_PLAN_TTL_MS + 1);
		expect(
			await installWorkflowPackage(f.t.db, { ...f.t.env, ...signing }, actor, f.request)
		).toEqual(first);
		expect(f.t.all('SELECT * FROM library_install')).toHaveLength(1);
	});

	it('rejects run keys in the service and exact-confirmation/file/stale failures with zero writes', async () => {
		for (const mode of ['run', 'confirm', 'file', 'stale'] as const) {
			const f = await fixture();
			const request = structuredClone(f.request);
			let acting = actor;
			if (mode === 'run') acting = { ...actor, agentRunId: 'arun_1' };
			if (mode === 'confirm') request.confirmation.plan_digest = `sha256:${'0'.repeat(64)}`;
			if (mode === 'file') {
				const changed = structuredClone(f.document);
				changed.workflows[0].description += ' changed';
				request.document_json = JSON.stringify(await withLibraryDocumentDigest(changed));
			}
			if (mode === 'stale')
				f.t.sqlite.exec(
					`INSERT INTO label(id,user_id,name,color,description,created_at,updated_at) VALUES('competitor','${USER}','QA','blue','',1,1)`
				);
			await expect(
				installWorkflowPackage(f.t.db, { ...f.t.env, ...signing }, acting, request)
			).rejects.toMatchObject({ status: mode === 'run' ? 403 : 409 });
			expect(f.t.all('SELECT * FROM library_install')).toEqual([]);
			expect(f.t.all('SELECT * FROM workflow WHERE user_id IS NOT NULL')).toEqual([]);
			expect(f.t.all('SELECT * FROM event')).toEqual([]);
		}
	});

	it('recovers by owner after key rotation but refuses POST replay by a different actor', async () => {
		const f = await fixture();
		const receipt = await installWorkflowPackage(
			f.t.db,
			{ ...f.t.env, ...signing },
			actor,
			f.request
		);
		const rotated = { ...actor, viaSession: false, apiKeyId: 'new-key', apiKeyName: 'new key' };
		expect(await getWorkflowPackageReceipt(f.t.db, rotated, receipt.id)).toEqual(receipt);
		await expect(
			installWorkflowPackage(f.t.db, { ...f.t.env, ...signing }, rotated, f.request)
		).rejects.toMatchObject({ status: 403, code: 'plan_actor_mismatch' });
		await expect(
			getWorkflowPackageReceipt(f.t.db, { ...rotated, userId: 'usr_someone_else' }, receipt.id)
		).rejects.toMatchObject({ status: 404, code: 'not_found' });
	});

	it('rejects an expired uncommitted plan without writing anything', async () => {
		const f = await fixture();
		vi.setSystemTime(Date.now() + PACKAGE_PLAN_TTL_MS + 1);
		await expect(
			installWorkflowPackage(f.t.db, { ...f.t.env, ...signing }, actor, f.request)
		).rejects.toMatchObject({ status: 409, code: 'plan_stale' });
		expect(f.t.all('SELECT * FROM library_install')).toEqual([]);
		expect(f.t.all('SELECT * FROM workflow WHERE user_id IS NOT NULL')).toEqual([]);
		expect(f.t.all('SELECT * FROM event')).toEqual([]);
	});

	it('installs selected schedules paused and tier rules against allocated states', async () => {
		const t = createTestDb();
		seedBase(t);
		const runner = addRunner(t, { type: 'local', config: { harness: 'codex' } });
		t.sqlite
			.prepare(
				'INSERT INTO routing_rule(id,user_id,targets,created_at,updated_at) VALUES(?,?,?,1,1)'
			)
			.run('global', USER, JSON.stringify([{ runner_id: runner }]));
		const document = await withLibraryDocumentDigest(automatedPackage());
		const document_json = JSON.stringify(document);
		const beforeDefault = t.all('SELECT default_workflow_id FROM project WHERE id=?', PROJECT)[0];
		const plan = await prepareWorkflowPackage(t.db, signing, actor, document_json, {
			inputs: {
				'input:1': { mode: 'create', name: 'qa', color: 'blue' },
				'input:2': { mode: 'reuse', id: PROJECT }
			},
			schedule_ids: ['schedule:1'],
			routing: { 'routing:1': 'balanced' }
		});
		const receipt = await installWorkflowPackage(t.db, { ...t.env, ...signing }, actor, {
			document_json,
			plan_token: plan.plan_token,
			confirmation: { plan_digest: plan.plan_digest }
		});
		expect(t.all('SELECT enabled,run_count FROM scheduled_task')).toEqual([
			{ enabled: 0, run_count: 0 }
		]);
		const rule = t.all("SELECT workflow_state_id,targets FROM routing_rule WHERE id!='global'")[0];
		expect(
			t.all('SELECT id FROM workflow_state').some((row) => row.id === rule.workflow_state_id)
		).toBe(true);
		expect(rule.targets).toContain('balanced');
		expect(t.all('SELECT default_workflow_id FROM project WHERE id=?', PROJECT)[0]).toEqual(
			beforeDefault
		);
		expect(t.all('SELECT * FROM issue')).toEqual([]);
		expect(receipt.objects.some((object) => object.kind === 'schedule')).toBe(true);
		expect(receipt.objects.some((object) => object.kind === 'routing')).toBe(true);
	});

	it('rechecks the destination inside the transaction and leaves no partial rows on a race', async () => {
		const f = await fixture();
		const realBatch = f.t.env.DB.batch.bind(f.t.env.DB);
		const racedEnv = {
			...f.t.env,
			...signing,
			DB: {
				...f.t.env.DB,
				batch: async (statements: Parameters<typeof realBatch>[0]) => {
					f.t.sqlite.exec(
						`INSERT INTO label(id,user_id,name,color,description,created_at,updated_at) VALUES('racer','${USER}','QA','blue','',1,1)`
					);
					return realBatch(statements);
				}
			}
		} as Env;
		await expect(installWorkflowPackage(f.t.db, racedEnv, actor, f.request)).rejects.toMatchObject({
			status: 409,
			code: 'plan_stale'
		});
		expect(f.t.all('SELECT * FROM library_install')).toEqual([]);
		expect(f.t.all('SELECT * FROM workflow WHERE user_id IS NOT NULL')).toEqual([]);
		expect(f.t.all('SELECT * FROM event')).toEqual([]);
	});

	it('rechecks expiry against transaction time after service reconstruction', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(Date.now() - PACKAGE_PLAN_TTL_MS + 1);
		const f = await fixture();
		await expect(
			installWorkflowPackage(f.t.db, { ...f.t.env, ...signing }, actor, f.request)
		).rejects.toMatchObject({ status: 409, code: 'plan_stale' });
		expect(f.t.all('SELECT * FROM library_install')).toEqual([]);
		expect(f.t.all('SELECT * FROM workflow WHERE user_id IS NOT NULL')).toEqual([]);
		expect(f.t.all('SELECT * FROM event')).toEqual([]);
	});

	it('does not let a receipt carrying an old execution nonce authorize child writes', async () => {
		const f = await fixture();
		const realBatch = f.t.env.DB.batch.bind(f.t.env.DB);
		const guardedEnv = {
			...f.t.env,
			...signing,
			DB: {
				...f.t.env.DB,
				batch: async (statements: Parameters<typeof realBatch>[0]) => {
					const bound = statements as unknown as Array<{ sqlText: string; params: unknown[] }>;
					const first = bound[0];
					return realBatch([
						{
							...first,
							params: [...first.params.slice(0, 6), 'exe_old', ...first.params.slice(7)]
						},
						...bound.slice(1)
					] as unknown as Parameters<typeof realBatch>[0]);
				}
			}
		} as Env;
		await expect(
			installWorkflowPackage(f.t.db, guardedEnv, actor, f.request)
		).rejects.toMatchObject({ status: 409, code: 'plan_stale' });
		expect(f.t.all('SELECT * FROM workflow WHERE user_id IS NOT NULL')).toEqual([]);
		expect(f.t.all('SELECT * FROM event')).toEqual([]);
		expect(f.t.all('SELECT * FROM library_install')).toHaveLength(1);
	});

	it('rejects selected schedule and routing phantoms at transaction time', async () => {
		for (const family of ['schedule', 'routing'] as const) {
			const t = createTestDb();
			seedBase(t);
			const runner = addRunner(t, { type: 'local', config: { harness: 'codex' } });
			t.sqlite
				.prepare(
					'INSERT INTO routing_rule(id,user_id,targets,created_at,updated_at) VALUES(?,?,?,1,1)'
				)
				.run('global', USER, JSON.stringify([{ runner_id: runner }]));
			const document = await withLibraryDocumentDigest(automatedPackage());
			const document_json = JSON.stringify(document);
			const plan = await prepareWorkflowPackage(t.db, signing, actor, document_json, {
				inputs: {
					'input:1': { mode: 'create', name: 'qa', color: 'blue' },
					'input:2': { mode: 'reuse', id: PROJECT }
				},
				schedule_ids: ['schedule:1'],
				routing: { 'routing:1': 'balanced' }
			});
			const realBatch = t.env.DB.batch.bind(t.env.DB);
			const racedEnv = {
				...t.env,
				...signing,
				DB: {
					...t.env.DB,
					batch: (statements: Parameters<typeof realBatch>[0]) => {
						if (family === 'schedule') {
							const workflow = t.all('SELECT id FROM workflow LIMIT 1')[0].id;
							t.sqlite
								.prepare(
									`INSERT INTO scheduled_task(id,project_id,name,title_template,description_template,workflow_id,cron,timezone,next_run_at,created_at,updated_at)
									 VALUES('phantom',?,?,?,?,?,'0 9 * * 1','UTC',1,1,1)`
								)
								.run(PROJECT, 'Weekly review', '', '', workflow);
						} else {
							t.sqlite
								.prepare('UPDATE routing_rule SET targets=?,updated_at=2 WHERE id=?')
								.run(JSON.stringify([{ runner_id: runner, tier: 'fast' }]), 'global');
						}
						return realBatch(statements);
					}
				}
			} as Env;
			await expect(
				installWorkflowPackage(t.db, racedEnv, actor, {
					document_json,
					plan_token: plan.plan_token,
					confirmation: { plan_digest: plan.plan_digest }
				})
			).rejects.toMatchObject({ status: 409, code: 'plan_stale' });
			expect(t.all('SELECT * FROM library_install')).toEqual([]);
			expect(t.all('SELECT * FROM workflow WHERE user_id IS NOT NULL')).toEqual([]);
			expect(t.all('SELECT * FROM event')).toEqual([]);
		}
	});

	it('rolls back every write family when a later statement fails', async () => {
		for (const family of [
			'context_item_file',
			'UPDATE "workflow_state"',
			'"label"',
			'"scheduled_task"',
			'"routing_rule"',
			'"event"'
		]) {
			const t = createTestDb();
			seedBase(t);
			const runner = addRunner(t, { type: 'local', config: { harness: 'codex' } });
			t.sqlite
				.prepare(
					'INSERT INTO routing_rule(id,user_id,targets,created_at,updated_at) VALUES(?,?,?,1,1)'
				)
				.run('global', USER, JSON.stringify([{ runner_id: runner }]));
			const document = await withLibraryDocumentDigest(automatedPackage());
			const document_json = JSON.stringify(document);
			const plan = await prepareWorkflowPackage(t.db, signing, actor, document_json, {
				inputs: {
					'input:1': { mode: 'create', name: 'qa', color: 'blue' },
					'input:2': { mode: 'reuse', id: PROJECT }
				},
				schedule_ids: ['schedule:1'],
				routing: { 'routing:1': 'balanced' }
			});
			const realBatch = t.env.DB.batch.bind(t.env.DB);
			const failingEnv = {
				...t.env,
				...signing,
				DB: {
					...t.env.DB,
					batch: (statements: Parameters<typeof realBatch>[0]) => {
						const bound = statements as unknown as Array<{ sqlText: string; params: unknown[] }>;
						const index = bound.findIndex((statement) => statement.sqlText.includes(family));
						expect(index, family).toBeGreaterThan(0);
						const changed = bound.map((statement, i) =>
							i === index
								? { ...statement, sqlText: 'INSERT INTO missing_install_test VALUES (1)' }
								: statement
						);
						return realBatch(changed as unknown as Parameters<typeof realBatch>[0]);
					}
				}
			} as Env;
			await expect(
				installWorkflowPackage(t.db, failingEnv, actor, {
					document_json,
					plan_token: plan.plan_token,
					confirmation: { plan_digest: plan.plan_digest }
				})
			).rejects.toThrow();
			expect(t.all('SELECT * FROM library_install')).toEqual([]);
			expect(t.all('SELECT * FROM workflow WHERE user_id IS NOT NULL')).toEqual([]);
			expect(t.all('SELECT * FROM context_item WHERE user_id IS NOT NULL')).toEqual([]);
			expect(t.all('SELECT * FROM event')).toEqual([]);
		}
	});

	it('recovers a lost first response and makes sequential/concurrent retries idempotent', async () => {
		const f = await fixture();
		const realBatch = f.t.env.DB.batch.bind(f.t.env.DB);
		let lose = true;
		const lossyEnv = {
			...f.t.env,
			...signing,
			DB: {
				...f.t.env.DB,
				batch: async (statements: Parameters<typeof realBatch>[0]) => {
					const result = await realBatch(statements);
					if (lose) {
						lose = false;
						throw new TypeError('connection reset after commit');
					}
					return result;
				}
			}
		} as Env;
		const recovered = await installWorkflowPackage(f.t.db, lossyEnv, actor, f.request);
		const retries = await Promise.all([
			installWorkflowPackage(f.t.db, lossyEnv, actor, f.request),
			installWorkflowPackage(f.t.db, lossyEnv, actor, f.request)
		]);
		expect(retries).toEqual([recovered, recovered]);
		expect(f.t.all('SELECT * FROM library_install')).toHaveLength(1);
		expect(f.t.all('SELECT * FROM workflow WHERE user_id IS NOT NULL')).toHaveLength(2);

		const duplicate = await fixture();
		const duplicateBatch = duplicate.t.env.DB.batch.bind(duplicate.t.env.DB);
		let race = true;
		const duplicateEnv = {
			...duplicate.t.env,
			...signing,
			DB: {
				...duplicate.t.env.DB,
				batch: async (statements: Parameters<typeof duplicateBatch>[0]) => {
					if (race) {
						race = false;
						await duplicateBatch(statements);
					}
					return duplicateBatch(statements);
				}
			}
		} as Env;
		const raced = await installWorkflowPackage(
			duplicate.t.db,
			duplicateEnv,
			actor,
			duplicate.request
		);
		expect(raced.id).toBe(duplicate.preview.plan_id);
		expect(duplicate.t.all('SELECT * FROM library_install')).toHaveLength(1);
		expect(duplicate.t.all('SELECT * FROM workflow WHERE user_id IS NOT NULL')).toHaveLength(2);
	});
});
