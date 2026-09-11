import { describe, expect, it } from 'vitest';
import { parseLibraryV3Document } from '@tines/shared';
import { USER, PROJECT, seedBase } from '../supervisor/test-fixtures';
import { createTestDb } from '../api/test-db';
import { createWorkflow, updateWorkflow } from '../api/workflows';
import { createContextItem } from '../api/context';
import { createLabel } from '../api/labels';
import { exportWorkflowPackage } from './export';
import { validatePortableLibrary } from './validate';

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
	const dependency = await createWorkflow(t.db, t.env, actor, {
		name: 'Shared',
		initial_state: 'Ready',
		states: [
			{ name: 'Ready', category: 'active', inherits_from: 'wfs_std_open' },
			{ name: 'Other', category: 'active' }
		],
		transitions: []
	});
	const main = await createWorkflow(t.db, t.env, actor, {
		name: 'Shared',
		description: 'Main definition',
		initial_state: 'Start',
		states: [
			{ name: 'Start', category: 'active', inherits_from: dependency.states[0].id },
			{ name: 'Done', category: 'done' }
		],
		transitions: [
			{
				name: 'Finish',
				from: 'Start',
				to: 'Done',
				requires: [{ artifact: 'report', type: 'text', content_type: 'text/markdown' }]
			}
		]
	});
	for (const [id, body] of [
		[main.states[0].id, 'Main override'],
		[dependency.states[0].id, 'Inherited original'],
		['wfs_std_open', 'System scoped instructions']
	] as const)
		await createContextItem(t.db, t.env, actor, {
			kind: 'prompt',
			name: 'instructions',
			body,
			workflow_state_id: id
		});
	await createContextItem(t.db, t.env, actor, {
		kind: 'skill',
		name: 'review',
		workflow_state_id: main.states[0].id,
		files: [
			{ path: 'SKILL.md', content: 'Review the output.' },
			{ path: 'extra.txt', content: 'More details.' }
		]
	});
	await createContextItem(t.db, t.env, actor, {
		kind: 'repo',
		name: 'repo',
		workflow_state_id: dependency.states[1].id,
		repo_url: 'https://github.com/tbuckley/tines',
		repo_branch: 'main',
		repo_dir: 'source'
	});
	const label = await createLabel(t.db, t.env, actor, { name: 'ambient' });
	for (const scope of [
		{},
		{ project_id: PROJECT },
		{ project_id: PROJECT, workflow_state_id: main.states[0].id },
		{ label_id: label.id, workflow_state_id: main.states[0].id }
	])
		await createContextItem(t.db, t.env, actor, {
			kind: 'prompt',
			name: 'ambient',
			body: 'DO NOT EXPORT',
			...scope
		});
	await createContextItem(t.db, t.env, actor, {
		kind: 'prompt',
		name: 'journal',
		body: 'DO NOT EXPORT JOURNAL',
		project_id: PROJECT,
		workflow_state_id: main.states[0].id
	});
	return { t, main, dependency };
}

describe('workflow package closure export', () => {
	it('copies complete inheritance including Standard, overridden instructions, gates, ordered skills and repo declarations only', async () => {
		const { t, main, dependency } = await fixture();
		const events = await t.db.selectFrom('event').selectAll().execute();
		const document = await exportWorkflowPackage(t.db, USER, main.id);
		expect(document.workflows.map((w) => w.name)).toEqual(['Shared', 'Standard', 'Shared']);
		expect(document.main_workflow_id).toBe(document.workflows[0].id);
		expect(document.workflows[0].transitions[0].requires).toEqual([
			{ artifact: 'report', type: 'text', content_type: 'text/markdown' }
		]);
		expect(
			document.context
				.filter((c) => c.kind === 'prompt')
				.map((c) => c.body)
				.sort()
		).toEqual(['Inherited original', 'Main override', 'System scoped instructions']);
		expect(document.context.find((c) => c.kind === 'skill')).toMatchObject({
			files: [
				{ path: 'SKILL.md', content: 'Review the output.' },
				{ path: 'extra.txt', content: 'More details.' }
			]
		});
		expect(document.context.find((c) => c.kind === 'repo')).toMatchObject({
			repo_branch: 'main',
			repo_dir: 'source'
		});
		expect(document.schedules).toEqual([]);
		expect(document.routing).toEqual([]);
		expect(document.inputs).toEqual([]);
		const bytes = JSON.stringify(document);
		for (const id of [main.id, dependency.id, main.states[0].id, 'wfs_std_open', PROJECT, USER])
			expect(bytes).not.toContain(id);
		expect(bytes).not.toContain('DO NOT EXPORT');
		expect(await parseLibraryV3Document(bytes)).toEqual(document);
		expect(await validatePortableLibrary(bytes)).toMatchObject({
			valid: true,
			digest: document.digest,
			document
		});
		expect(await t.db.selectFrom('event').selectAll().execute()).toEqual(events);
		await updateWorkflow(t.db, t.env, actor, main.id, {
			description: 'Changed after the file was saved'
		});
		expect((await validatePortableLibrary(bytes)).digest).toBe(document.digest);
	});
	it('selects schedules and tier-only preferences explicitly without carrying source IDs or runtime state', async () => {
		const { t, main, dependency } = await fixture();
		for (const [i, state] of [null, main.states[0].id].entries())
			await t.db
				.insertInto('scheduled_task')
				.values({
					id: `schedule-source-${i}`,
					project_id: PROJECT,
					name: `Daily ${i}`,
					title_template: 'Review {{date}}',
					description_template: 'Do the review',
					workflow_id: main.id,
					state_id: state,
					cron: '0 9 * * *',
					preset: i === 0 ? JSON.stringify({ kind: 'daily', time: '09:00' }) : null,
					timezone: 'UTC',
					require_all_closed: 1,
					enabled: 1,
					next_run_at: 100,
					last_run_at: 99,
					run_count: 42,
					created_at: i,
					updated_at: i
				})
				.execute();
		const document = await exportWorkflowPackage(t.db, USER, main.id, {
			source_project_id: PROJECT,
			schedule_ids: ['schedule-source-1', 'schedule-source-0'],
			tiers: [
				{ state_id: main.states[0].id, tier: 'balanced', project_scoped: true },
				{ state_id: dependency.states[0].id, tier: 'smartest' }
			]
		});
		expect(document.schedules).toMatchObject([
			{
				recurrence: { kind: 'preset', preset: { kind: 'daily', time: '09:00' } },
				start_state: null
			},
			{
				recurrence: { kind: 'cron', cron: '0 9 * * *' },
				start_state: { kind: 'bundled_state', state_id: document.workflows[0].states[0].id }
			}
		]);
		expect(document.inputs).toMatchObject([
			{ key: 'destination_project', type: 'project', default: null }
		]);
		expect(document.routing.map((r) => r.tier)).toEqual(['balanced', 'smartest']);
		for (const forbidden of [
			'schedule-source-',
			PROJECT,
			'runner_id',
			'run_count',
			'enabled',
			'last_run_at'
		])
			expect(JSON.stringify(document)).not.toContain(forbidden);
		expect((await validatePortableLibrary(JSON.stringify(document))).valid).toBe(true);
		expect(
			(await exportWorkflowPackage(t.db, USER, main.id, { source_project_id: PROJECT })).schedules
		).toEqual([]);
	});
	it('validates explicit declarations against already-tokenized source fields without rewriting source', async () => {
		const { t, main } = await fixture();
		const input = {
			id: 'input:filing',
			key: 'filing',
			type: 'label' as const,
			label: 'Filing label',
			description: '',
			required: true,
			default: 'review'
		};
		await updateWorkflow(t.db, t.env, actor, main.id, {
			description: 'File under {{filing:review}}'
		});
		const authoring = {
			inputs: [input],
			text_uses: [
				{
					id: 'use:filing',
					target: { record_id: 'workflow:1', field: 'description' as const },
					input_id: input.id,
					token: '{{filing:review}}'
				}
			]
		};
		const document = await exportWorkflowPackage(t.db, USER, main.id, { authoring });
		expect(document.inputs).toEqual([input]);
		expect(document.text_uses).toEqual(authoring.text_uses);
		expect(document.workflows[0].description).toBe('File under {{filing:review}}');
		expect((await validatePortableLibrary(JSON.stringify(document))).valid).toBe(true);
		await expect(
			exportWorkflowPackage(t.db, USER, main.id, {
				authoring: {
					...authoring,
					text_uses: [{ ...authoring.text_uses[0], token: '{{other:review}}' }]
				}
			})
		).rejects.toThrow();
	});
	it('rejects foreign main/project, unknown or unrelated schedule/state and malformed selections', async () => {
		const { t, main } = await fixture();
		await expect(exportWorkflowPackage(t.db, USER, 'foreign')).rejects.toMatchObject({
			status: 404
		});
		for (const options of [
			{ source_project_id: 'foreign' },
			{ schedule_ids: ['missing'] },
			{ source_project_id: PROJECT, schedule_ids: ['missing'] },
			{ tiers: [{ state_id: 'foreign', tier: 'balanced' as const }] },
			{ tiers: [{ state_id: main.states[0].id, tier: 'balanced' as const, project_scoped: true }] }
		])
			await expect(exportWorkflowPackage(t.db, USER, main.id, options)).rejects.toThrow();
		expect(await t.db.selectFrom('scheduled_task').selectAll().execute()).toEqual([]);
	});
	it('validates missing digest but returns path diagnostics for tampered or malformed files', async () => {
		const { t, main } = await fixture();
		const document = await exportWorkflowPackage(t.db, USER, main.id);
		const { digest, ...unsigned } = document;
		expect(await validatePortableLibrary(JSON.stringify(unsigned))).toMatchObject({
			valid: true,
			digest
		});
		expect(
			await validatePortableLibrary(
				JSON.stringify({ ...document, exported_at: document.exported_at + 1 })
			)
		).toMatchObject({ valid: false, diagnostics: [{ path: '/digest', code: 'digest_mismatch' }] });
		expect(
			await validatePortableLibrary('{"format":"tines.library","format":"other"}')
		).toMatchObject({ valid: false, diagnostics: [{ path: '/format', code: 'duplicate_key' }] });
	});
});
