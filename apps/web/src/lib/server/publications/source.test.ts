import { describe, expect, it } from 'vitest';
import { TEST_NOOP_DISPATCH_EFFECTS } from '$lib/server/api/test-dispatch-effects';
import { createTestDb } from '../api/test-db';
import { createContextItem } from '../api/context';
import { createWorkflow, updateWorkflow } from '../api/workflows';
import { PROJECT, USER, seedBase } from '../supervisor/test-fixtures';
import {
	buildOwnedPublicationSourceProof,
	readPublicationSource,
	resolvePublicationSourceSelection
} from './source';

const actor = {
	userId: USER,
	userName: 'Alice',
	apiKeyId: null,
	apiKeyName: null,
	viaSession: true
};

async function fixture() {
	const t = createTestDb();
	seedBase(t);
	const workflow = await createWorkflow(t.db, t.env, actor, {
		name: 'Publish me',
		initial_state: 'Draft',
		states: [
			{ name: 'Draft', category: 'active' },
			{ name: 'Done', category: 'done' }
		],
		transitions: [{ name: 'Finish', from: 'Draft', to: 'Done' }]
	});
	const skill = await createContextItem(t.db, t.env, actor, {
		kind: 'skill',
		name: 'review',
		workflow_state_id: workflow.states[0].id,
		files: [{ path: 'SKILL.md', content: 'First version' }]
	});
	await t.db
		.insertInto('scheduled_task')
		.values({
			id: 'schedule-publication-source',
			project_id: PROJECT,
			name: 'Daily review',
			title_template: 'Review {{date}}',
			description_template: 'Review it',
			workflow_id: workflow.id,
			state_id: workflow.states[0].id,
			cron: '0 9 * * *',
			preset: null,
			timezone: 'UTC',
			require_all_closed: 1,
			enabled: 1,
			next_run_at: 100,
			last_run_at: null,
			run_count: 0,
			created_at: 1,
			updated_at: 1
		})
		.execute();
	const options = {
		source_project_id: PROJECT,
		schedule_ids: ['schedule-publication-source']
	};
	const selection = await resolvePublicationSourceSelection(t.db, USER, workflow.id, options);
	return { t, workflow, skill, selection };
}

describe('publication source witness', () => {
	it('builds repeatable package bytes against the same frozen source proof', async () => {
		const { t, workflow } = await fixture();
		const first = await buildOwnedPublicationSourceProof(t.db, USER, workflow.id, {}, 12345);
		const second = await buildOwnedPublicationSourceProof(t.db, USER, workflow.id, {}, 12345);
		expect(second.document).toEqual(first.document);
		expect(second.witnessRaw).toBe(first.witnessRaw);
		expect(second.witnessFingerprint).toBe(first.witnessFingerprint);
		expect(first.document.exported_at).toBe(12345);
	});

	it('projects all selected source content once while excluding volatile and unrelated rows', async () => {
		const { t, selection } = await fixture();
		const before = await readPublicationSource(t.db, USER, selection);
		expect(JSON.parse(before.raw)).toMatchObject({
			project: { id: PROJECT },
			schedules: [{ id: 'schedule-publication-source', name: 'Daily review' }]
		});
		expect(before.raw).toContain('First version');
		expect(before.raw).not.toContain('run_count');
		expect(before.raw).not.toContain('next_run_at');

		await t.db
			.updateTable('scheduled_task')
			.set({ run_count: 12, next_run_at: 999, last_run_at: 500, enabled: 0 })
			.where('id', '=', 'schedule-publication-source')
			.execute();
		expect((await readPublicationSource(t.db, USER, selection)).fingerprint).toBe(
			before.fingerprint
		);
		await createContextItem(t.db, t.env, actor, {
			kind: 'prompt',
			name: 'unrelated',
			body: 'Not selected',
			project_id: PROJECT
		});
		expect((await readPublicationSource(t.db, USER, selection)).fingerprint).toBe(
			before.fingerprint
		);
	});

	it('changes for workflow, selected schedule, context membership, and skill file edits', async () => {
		const { t, workflow, skill, selection } = await fixture();
		let previous = (await readPublicationSource(t.db, USER, selection)).fingerprint;
		const changed = async () => {
			const next = (await readPublicationSource(t.db, USER, selection)).fingerprint;
			expect(next).not.toBe(previous);
			previous = next;
		};

		await updateWorkflow(t.db, t.env, actor, TEST_NOOP_DISPATCH_EFFECTS, workflow.id, {
			description: 'Changed description'
		});
		await changed();
		await t.db
			.updateTable('scheduled_task')
			.set({ title_template: 'Changed {{date}}' })
			.where('id', '=', 'schedule-publication-source')
			.execute();
		await changed();
		await createContextItem(t.db, t.env, actor, {
			kind: 'prompt',
			name: 'instructions',
			body: 'New selected context',
			workflow_state_id: workflow.states[0].id
		});
		await changed();
		await t.db
			.updateTable('context_item_file')
			.set({ content: 'Second version' })
			.where('context_item_id', '=', skill.id)
			.execute();
		await changed();
	});

	it('rejects the shared system workflow as a publication source', async () => {
		const t = createTestDb();
		seedBase(t);
		await expect(
			resolvePublicationSourceSelection(t.db, USER, 'wf_standard', {})
		).rejects.toMatchObject({
			status: 403,
			code: 'publication_source_forbidden'
		});
	});
});
