import { afterEach, describe, expect, it, vi } from 'vitest';
import { withLibraryDocumentDigest } from '@tines/shared';
import { inheritedPackage } from '../../../../../../packages/shared/src/library/fixtures';
import { createTestDb } from '../api/test-db';
import { USER, seedBase } from '../supervisor/test-fixtures';
import { getWorkflowPackageReceipt, installWorkflowPackage } from './install';
import { prepareWorkflowPackage } from './plan';
import { PACKAGE_PLAN_TTL_MS } from './token';

const actor = {
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
		expect(first.objects.filter((o) => o.kind === 'workflow')).toHaveLength(2);
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
	});
});
