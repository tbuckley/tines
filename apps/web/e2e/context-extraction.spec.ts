import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
	ContextItem,
	EffectiveContext,
	IssueDetail,
	Project,
	WorkflowResponse
} from '@tines/shared';
import { expect, test } from '@playwright/test';
import { ALICE, BASE_URL } from './constants.mjs';
import { apiClient, body, errorBody, runId } from './helpers';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const FIXTURES = join(
	ROOT,
	'apps/web/src/lib/server/api/fixtures/launch-context/scoped-extraction'
);
const CLI_DIR = join(ROOT, 'packages/cli');
const TSX = join(CLI_DIR, 'node_modules/.bin/tsx');
const CLI = join(CLI_DIR, 'src/index.ts');

function cli(args: string[]): string {
	return execFileSync(TSX, [CLI, ...args, '--url', BASE_URL, '--api-key', ALICE.apiKey], {
		encoding: 'utf8',
		env: { ...process.env, TINES_API_URL: 'https://ambient-must-not-be-used.invalid' }
	});
}

type Receipt = {
	case: string;
	sequence: number;
	operation: string;
	status: number | 'ok';
	detail: Record<string, unknown>;
};

test('four scoped extractions execute destination-first and retain sources on every stop', async ({
	request
}, testInfo) => {
	test.setTimeout(120_000);
	const api = apiClient(request, ALICE.apiKey);
	const receipts: Receipt[] = [];
	let sequence = 0;
	const record = (caseId: string, operation: string, status: Receipt['status'], detail = {}) =>
		receipts.push({ case: caseId, sequence: ++sequence, operation, status, detail });

	for (const caseId of ['global', 'project', 'state', 'combined'] as const) {
		const workflow = await body<WorkflowResponse>(
			await api.post('/api/v1/workflows', {
				name: `extract-${caseId}-${runId}`,
				initial_state: 'Child',
				states: [
					{ name: 'Root', category: 'active' },
					{ name: 'Child', category: 'active', inherits_from: 'Root' },
					{ name: 'Other', category: 'active' }
				],
				transitions: []
			})
		);
		const project = await body<Project>(
			await api.post('/api/v1/projects', {
				name: `extract-${caseId}-${runId}`,
				default_workflow_id: workflow.id
			})
		);
		const issue = await body<IssueDetail>(
			await api.post(`/api/v1/projects/${project.id}/issues`, { title: `${caseId} consumer` })
		);
		const rootState = workflow.states.find((state) => state.name === 'Root')!;
		const scope = {
			...(caseId === 'project' || caseId === 'combined' ? { project_id: project.id } : {}),
			...(caseId === 'state' || caseId === 'combined' ? { workflow_state_id: rootState.id } : {})
		};
		const before = readFileSync(join(FIXTURES, caseId, 'before.md'), 'utf8');
		const after = readFileSync(join(FIXTURES, caseId, 'after.md'), 'utf8');
		const skillBody = readFileSync(join(FIXTURES, caseId, 'skill/SKILL.md'), 'utf8');
		const keepPath = join(FIXTURES, caseId, 'skill/notes/keep.txt');
		const keep = ['project', 'combined'].includes(caseId) ? readFileSync(keepPath, 'utf8') : null;
		const source = await body<ContextItem>(
			await api.post('/api/v1/context', {
				kind: 'prompt',
				name: caseId === 'combined' ? 'journal' : `procedure-source-${caseId}-${runId}`,
				body: before,
				...scope
			})
		);
		record(caseId, 'proposal_rejected_unmentioned', 'ok', {
			proposed: true,
			rejected_source_version: source.version,
			unmentioned_source_version: source.version
		});

		const invalid = await api.post('/api/v1/context', {
			kind: 'skill',
			name: `invalid-${caseId}-${runId}`,
			files: [{ path: '../escape', content: skillBody }],
			...scope
		});
		expect(invalid.status()).toBe(422);
		record(caseId, 'invalid_destination', invalid.status(), {
			error: (await errorBody(invalid)).error.code,
			source_version: (await body<ContextItem>(await api.get(`/api/v1/context/${source.id}`)))
				.version
		});

		let destination: ContextItem;
		if (keep === null) {
			destination = await body<ContextItem>(
				await api.post('/api/v1/context', {
					kind: 'skill',
					name: 'planning-procedures',
					description: `Read skills/planning-procedures/SKILL.md when ${caseId} planning applies.`,
					files: [{ path: 'SKILL.md', content: skillBody }],
					...scope
				})
			);
		} else {
			destination = await body<ContextItem>(
				await api.post('/api/v1/context', {
					kind: 'skill',
					name: 'planning-procedures',
					description: `Read skills/planning-procedures/SKILL.md when ${caseId} planning applies.`,
					files: [
						{ path: 'SKILL.md', content: '# Existing unrelated section\n\nKeep this section.\n' },
						{ path: 'notes/keep.txt', content: keep }
					],
					...scope
				})
			);
			cli([
				'context',
				'edit',
				destination.id,
				'--file',
				`SKILL.md=@${join(FIXTURES, caseId, 'skill/SKILL.md')}`,
				'--expect-version',
				String(destination.version)
			]);
			destination = await body<ContextItem>(await api.get(`/api/v1/context/${destination.id}`));
		}
		record(caseId, 'destination_write_interrupt', destination.version, {
			destination_id: destination.id,
			source_version: source.version,
			files: destination.files?.map((file) => file.path)
		});
		expect(destination.files).toContainEqual({ path: 'SKILL.md', content: skillBody });
		if (keep !== null)
			expect(destination.files).toContainEqual({ path: 'notes/keep.txt', content: keep });

		const effective = await body<EffectiveContext>(
			await api.get(`/api/v1/issues/${issue.id}/context`)
		);
		const winner = effective.skills.find((skill) => skill.name === 'planning-procedures')!;
		expect(winner.item_id).toBe(destination.id);
		record(caseId, 'effective_resolution_after_resume', 'ok', {
			winner: winner.item_id,
			scope: winner.scope,
			inherited_from: winner.inherited_from
		});

		const exportDir = mkdtempSync(join(tmpdir(), `tines-528-${caseId}-`));
		cli(['issues', 'context', `${project.name}/${issue.number}`, '--out', exportDir]);
		expect(readFileSync(join(exportDir, 'skills/planning-procedures/SKILL.md'), 'utf8')).toBe(
			skillBody
		);
		record(caseId, 'fresh_export_needed_read', 'ok', {
			paths: ['prompt.md', 'skills/planning-procedures/SKILL.md'],
			needed_read: true,
			unneeded_read: false
		});

		const nonempty = mkdtempSync(join(tmpdir(), `tines-528-nonempty-${caseId}-`));
		writeFileSync(join(nonempty, 'keep'), 'occupied');
		expect(() =>
			cli(['issues', 'context', `${project.name}/${issue.number}`, '--out', nonempty])
		).toThrow(/non-empty/);
		record(caseId, 'nonempty_export_source_retained', 'ok', {
			source_version: source.version
		});

		const wrongOverride = await body<ContextItem>(
			await api.post('/api/v1/context', {
				kind: 'skill',
				name: 'planning-procedures',
				issue_id: issue.id,
				files: [{ path: 'SKILL.md', content: 'wrong override' }]
			})
		);
		const wrong = await body<EffectiveContext>(await api.get(`/api/v1/issues/${issue.id}/context`));
		expect(wrong.skills.find((skill) => skill.name === 'planning-procedures')?.item_id).toBe(
			wrongOverride.id
		);
		record(caseId, 'wrong_override_source_retained', 'ok', { winner: wrongOverride.id });
		await api.delete(`/api/v1/context/${wrongOverride.id}`);

		const concurrent = await body<ContextItem>(
			await api.patch(`/api/v1/context/${source.id}`, {
				body: `${before}\nConcurrent material edit.`,
				expected_version: source.version
			})
		);
		const stale = await api.patch(`/api/v1/context/${source.id}`, {
			body: after,
			expected_version: source.version
		});
		expect(stale.status()).toBe(409);
		record(caseId, 'source_cas_conflict_retained', stale.status(), {
			current_version: concurrent.version,
			body_retained: (await body<ContextItem>(await api.get(`/api/v1/context/${source.id}`))).body
		});

		const resumedSource = await body<ContextItem>(await api.get(`/api/v1/context/${source.id}`));
		const resumedDestination = await body<ContextItem>(
			await api.get(`/api/v1/context/${destination.id}`)
		);
		expect(resumedDestination.files).toContainEqual({ path: 'SKILL.md', content: skillBody });
		const applied = await body<ContextItem>(
			await api.patch(`/api/v1/context/${source.id}`, {
				body: after,
				expected_version: resumedSource.version
			})
		);
		record(caseId, 'resume_reverify_then_source_cas', applied.version, {
			destination_version: resumedDestination.version,
			source_body: applied.body
		});
		expect(applied.body).toBe(after);
		expect(
			receipts.findIndex((r) => r.case === caseId && r.operation === 'fresh_export_needed_read')
		).toBeLessThan(
			receipts.findIndex(
				(r) => r.case === caseId && r.operation === 'resume_reverify_then_source_cas'
			)
		);

		await api.delete(`/api/v1/context/${destination.id}`);
		const afterMissing = await body<ContextItem>(await api.get(`/api/v1/context/${source.id}`));
		record(caseId, 'resume_missing_destination_source_retained', 'ok', {
			source_version: afterMissing.version,
			source_body: afterMissing.body
		});
		await api.delete(`/api/v1/context/${source.id}`);
	}

	const receiptPath = testInfo.outputPath('scoped-extraction-receipts.json');
	mkdirSync(dirname(receiptPath), { recursive: true });
	writeFileSync(receiptPath, `${JSON.stringify(receipts, null, 2)}\n`);
	await testInfo.attach('scoped-extraction-receipts', {
		path: receiptPath,
		contentType: 'application/json'
	});
});

test('same-name resolution follows exact scope rank and inherited-state provenance', async ({
	request
}) => {
	const api = apiClient(request, ALICE.apiKey);
	const workflow = await body<WorkflowResponse>(
		await api.post('/api/v1/workflows', {
			name: `extract-matrix-${runId}`,
			initial_state: 'Child',
			states: [
				{ name: 'Root', category: 'active' },
				{ name: 'Child', category: 'active', inherits_from: 'Root' },
				{ name: 'Other', category: 'active' }
			],
			transitions: []
		})
	);
	const root = workflow.states.find((state) => state.name === 'Root')!;
	const child = workflow.states.find((state) => state.name === 'Child')!;
	const projectP = await body<Project>(
		await api.post('/api/v1/projects', {
			name: `extract-matrix-p-${runId}`,
			default_workflow_id: workflow.id
		})
	);
	const projectQ = await body<Project>(
		await api.post('/api/v1/projects', {
			name: `extract-matrix-q-${runId}`,
			default_workflow_id: workflow.id
		})
	);
	const makeIssue = async (project: Project, state?: string) =>
		body<IssueDetail>(
			await api.post(`/api/v1/projects/${project.id}/issues`, {
				title: `matrix ${project.name} ${state ?? 'Child'}`,
				...(state ? { state } : {})
			})
		);
	const [pChild, pOther, qChild] = await Promise.all([
		makeIssue(projectP),
		makeIssue(projectP, 'Other'),
		makeIssue(projectQ)
	]);
	const makeSkill = async (marker: string, scope: Record<string, string> = {}) =>
		body<ContextItem>(
			await api.post('/api/v1/context', {
				kind: 'skill',
				name: 'planning-procedures',
				files: [{ path: 'SKILL.md', content: marker }],
				...scope
			})
		);
	const global = await makeSkill('global');
	const project = await makeSkill('project', { project_id: projectP.id });
	const state = await makeSkill('state-root', { workflow_state_id: root.id });
	const combined = await makeSkill('combined-root', {
		project_id: projectP.id,
		workflow_state_id: root.id
	});
	const winner = async (issue: IssueDetail) => {
		const context = await body<EffectiveContext>(
			await api.get(`/api/v1/issues/${issue.id}/context`)
		);
		return context.skills.find((skill) => skill.name === 'planning-procedures')!;
	};
	expect((await winner(pOther)).item_id).toBe(project.id);
	const qWinner = await winner(qChild);
	expect(qWinner.item_id).toBe(state.id);
	expect(qWinner.inherited_from?.state_id).toBe(root.id);
	const leaf = await makeSkill('state-leaf', { workflow_state_id: child.id });
	expect((await winner(qChild)).item_id).toBe(leaf.id);
	const pWinner = await winner(pChild);
	expect(pWinner.item_id).toBe(combined.id);
	expect(pWinner.inherited_from).toEqual({
		state_id: root.id,
		state_name: 'Root',
		workflow_id: workflow.id,
		workflow_name: workflow.name
	});
	for (const item of [leaf, combined, state, project, global])
		await api.delete(`/api/v1/context/${item.id}`);
});
