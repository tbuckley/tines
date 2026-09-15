import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
	ContextItem,
	EffectiveContext,
	IssueDetail,
	IssueJournalResponse,
	Project,
	WorkflowResponse
} from '@tines/shared';
import { expect, test } from '@playwright/test';
import { ALICE, BASE_URL } from './constants.mjs';
import { apiClient, body, errorBody, runId } from './helpers';
import {
	expectedPlanningProcedure,
	planningProcedure,
	type ExtractionCase
} from '../src/lib/server/api/fixtures/launch-context/scoped-extraction/procedure-contract';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const FIXTURES = join(
	ROOT,
	'apps/web/src/lib/server/api/fixtures/launch-context/scoped-extraction'
);
const CLI_DIR = join(ROOT, 'packages/cli');
const TSX = join(CLI_DIR, 'node_modules/.bin/tsx');
const CLI = join(CLI_DIR, 'src/index.ts');

const CONDITIONAL_MARKER = {
	global: 'Inspect the target workflow',
	project: "Inspect project P's Engineering workflow",
	state: 'Read the rejection and the current design',
	combined: 'Re-read the rejection and current source/destination versions'
} as const;

const UNIVERSAL_MARKER = {
	global: 'Always preserve human decisions',
	project: 'Always preserve exact current comment bodies',
	state: 'Always verify acceptance',
	combined: 'Always preserve source-version conflicts'
} as const;

const READ_CONDITION = {
	global:
		'Read skills/planning-procedures/SKILL.md when a task must enter or re-propose planning work.',
	project: 'Read skills/planning-procedures/SKILL.md when planning work for project P.',
	state:
		'Read skills/planning-procedures/SKILL.md only when a Root or inheriting child task requires rework.',
	combined:
		'Read skills/planning-procedures/SKILL.md when project P work inherited from Root needs a second proposal.'
} as const;

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
		const otherProject = await body<Project>(
			await api.post('/api/v1/projects', {
				name: `extract-${caseId}-other-${runId}`,
				default_workflow_id: workflow.id
			})
		);
		const projectOtherIssue = await body<IssueDetail>(
			await api.post(`/api/v1/projects/${project.id}/issues`, {
				title: `${caseId} project other-state consumer`,
				state: 'Other'
			})
		);
		const otherProjectChildIssue = await body<IssueDetail>(
			await api.post(`/api/v1/projects/${otherProject.id}/issues`, {
				title: `${caseId} other-project child consumer`
			})
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
		for (const decision of ['proposed', 'rejected', 'unmentioned'] as const) {
			const reviewSource = await body<ContextItem>(
				await api.post('/api/v1/context', {
					kind: 'prompt',
					name: `review-${decision}-${caseId}-${runId}`,
					body: before,
					...scope
				})
			);
			const retained = await body<ContextItem>(await api.get(`/api/v1/context/${reviewSource.id}`));
			expect(retained.body).toBe(before);
			record(caseId, `review_${decision}_source_retained`, 'ok', {
				source_id: reviewSource.id,
				source_version: retained.version,
				source_body: retained.body
			});
			await api.delete(`/api/v1/context/${reviewSource.id}`);
		}

		const source = await body<ContextItem>(
			await api.post('/api/v1/context', {
				kind: 'prompt',
				name: caseId === 'combined' ? 'journal' : `procedure-source-${caseId}-${runId}`,
				body: before,
				...scope
			})
		);
		if (caseId === 'combined') {
			const journal = await body<IssueJournalResponse>(
				await api.get(`/api/v1/issues/${issue.id}/journal`)
			);
			expect(journal).toMatchObject({
				anchor: 'current',
				scope: { project_id: project.id, workflow_state_id: rootState.id },
				item: { id: source.id, version: source.version, body: before }
			});
			const effectiveJournal = await body<EffectiveContext>(
				await api.get(`/api/v1/issues/${issue.id}/context`)
			);
			expect(effectiveJournal.prompt.journal).toEqual({
				state_id: rootState.id,
				item_id: source.id,
				version: source.version,
				inherited_from: {
					state_id: rootState.id,
					state_name: 'Root',
					workflow_id: workflow.id,
					workflow_name: workflow.name
				}
			});
			const journalPart = effectiveJournal.prompt.parts.find((part) => part.item_id === source.id);
			expect(journalPart?.inherited_from).toEqual(effectiveJournal.prompt.journal.inherited_from);
			const shown = JSON.parse(
				cli(['journal', 'show', `${project.name}/${issue.number}`, '--json'])
			) as ContextItem;
			expect(shown).toMatchObject({
				id: source.id,
				version: source.version,
				body: before,
				scope: { project_id: project.id, workflow_state_id: rootState.id }
			});
			record(caseId, 'journal_root_show', 'ok', {
				item_id: source.id,
				scope: journal.scope,
				inherited_from: journalPart?.inherited_from
			});
		}
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
					description: READ_CONDITION[caseId],
					files: [{ path: 'SKILL.md', content: skillBody }],
					...scope
				})
			);
		} else {
			destination = await body<ContextItem>(
				await api.post('/api/v1/context', {
					kind: 'skill',
					name: 'planning-procedures',
					description: READ_CONDITION[caseId],
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
		expect(destination.scope).toMatchObject({
			project_id: 'project_id' in scope ? scope.project_id : null,
			workflow_state_id: 'workflow_state_id' in scope ? scope.workflow_state_id : null,
			issue_id: null,
			label_id: null
		});
		const unavailableDestination = await body<ContextItem>(
			await api.post('/api/v1/context', {
				kind: 'skill',
				name: `unavailable-${caseId}-${runId}`,
				files: [{ path: 'SKILL.md', content: skillBody }],
				...scope
			})
		);
		await api.delete(`/api/v1/context/${unavailableDestination.id}`);
		const unavailableRead = await api.get(`/api/v1/context/${unavailableDestination.id}`);
		expect(unavailableRead.status()).toBe(404);
		const sourceAfterUnavailable = await body<ContextItem>(
			await api.get(`/api/v1/context/${source.id}`)
		);
		expect(sourceAfterUnavailable.body).toBe(before);
		record(caseId, 'missing_destination_source_retained', unavailableRead.status(), {
			source_version: sourceAfterUnavailable.version,
			source_body: sourceAfterUnavailable.body
		});
		record(caseId, 'destination_write', destination.version, {
			destination_id: destination.id,
			source_version: source.version,
			files: destination.files?.map((file) => file.path)
		});
		const completeDestination = await body<ContextItem>(
			await api.get(`/api/v1/context/${destination.id}`)
		);
		expect(completeDestination.files).toContainEqual({ path: 'SKILL.md', content: skillBody });
		if (keep !== null)
			expect(completeDestination.files).toContainEqual({ path: 'notes/keep.txt', content: keep });
		record(caseId, 'destination_complete_read', 'ok', {
			destination_id: completeDestination.id,
			version: completeDestination.version,
			files: completeDestination.files?.map((file) => file.path)
		});

		const effective = await body<EffectiveContext>(
			await api.get(`/api/v1/issues/${issue.id}/context`)
		);
		const winner = effective.skills.find((skill) => skill.name === 'planning-procedures')!;
		expect(winner.item_id).toBe(destination.id);
		expect(winner.scope).toMatchObject({
			project_id: destination.scope.project_id,
			workflow_state_id: destination.scope.workflow_state_id,
			workflow_id: destination.scope.workflow_id,
			issue_id: null,
			label_id: null
		});
		expect(winner.inherited_from).toEqual(
			caseId === 'state' || caseId === 'combined'
				? {
						state_id: rootState.id,
						state_name: 'Root',
						workflow_id: workflow.id,
						workflow_name: workflow.name
					}
				: null
		);
		record(caseId, 'effective_resolution', 'ok', {
			winner: winner.item_id,
			scope: winner.scope,
			inherited_from: winner.inherited_from
		});
		const winnerFor = async (target: IssueDetail) => {
			const context = await body<EffectiveContext>(
				await api.get(`/api/v1/issues/${target.id}/context`)
			);
			return context.skills.find((skill) => skill.name === 'planning-procedures');
		};
		const boundary = {
			project_other_state: (await winnerFor(projectOtherIssue))?.item_id ?? null,
			other_project_child: (await winnerFor(otherProjectChildIssue))?.item_id ?? null
		};
		expect(boundary).toEqual({
			project_other_state: caseId === 'global' || caseId === 'project' ? destination.id : null,
			other_project_child: caseId === 'global' || caseId === 'state' ? destination.id : null
		});
		record(caseId, 'scope_visibility_boundaries', 'ok', boundary);

		const exportDir = mkdtempSync(join(tmpdir(), `tines-528-${caseId}-`));
		cli(['issues', 'context', `${project.name}/${issue.number}`, '--out', exportDir]);
		expect(readFileSync(join(exportDir, 'skills/planning-procedures/SKILL.md'), 'utf8')).toBe(
			skillBody
		);
		record(caseId, 'fresh_directory_export', 'ok', {
			path: 'skills/planning-procedures/SKILL.md',
			body: skillBody
		});
		const neededReads: string[] = ['effective-context'];
		const neededRead = (relative: string) => {
			neededReads.push(relative);
			return readFileSync(join(exportDir, relative), 'utf8');
		};
		expect(winner.description).toBe(READ_CONDITION[caseId]);
		const neededSkill = neededRead('skills/planning-procedures/SKILL.md');
		const plan = planningProcedure(caseId as ExtractionCase, neededSkill);
		expect(plan).toEqual(expectedPlanningProcedure(caseId as ExtractionCase));
		expect(neededReads).toEqual(['effective-context', 'skills/planning-procedures/SKILL.md']);
		record(caseId, 'needed_task_runtime_read', 'ok', {
			task: `${caseId} needs planning procedure`,
			reads: neededReads,
			observed_step: CONDITIONAL_MARKER[caseId],
			ordered_plan: plan
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

		const changedDestination = await body<ContextItem>(
			await api.patch(`/api/v1/context/${destination.id}`, {
				files: [{ path: 'SKILL.md', content: 'changed destination' }],
				expected_version: destination.version
			})
		);
		expect((await body<ContextItem>(await api.get(`/api/v1/context/${source.id}`))).body).toBe(
			before
		);
		record(caseId, 'resume_changed_destination_source_retained', 'ok', {
			destination_version: changedDestination.version,
			source_body: before
		});
		destination = await body<ContextItem>(
			await api.patch(`/api/v1/context/${destination.id}`, {
				files: [
					{ path: 'SKILL.md', content: skillBody },
					...(keep === null ? [] : [{ path: 'notes/keep.txt', content: keep }])
				],
				expected_version: changedDestination.version
			})
		);
		const staleDestination = await api.patch(`/api/v1/context/${destination.id}`, {
			description: 'stale write must fail',
			expected_version: changedDestination.version
		});
		expect(staleDestination.status()).toBe(409);
		expect((await body<ContextItem>(await api.get(`/api/v1/context/${source.id}`))).body).toBe(
			before
		);
		record(caseId, 'stale_destination_source_retained', staleDestination.status(), {
			source_body: before
		});

		if (caseId === 'combined') {
			const concurrent = await body<ContextItem>(
				await api.patch(`/api/v1/context/${source.id}`, {
					body: `${before}\nConcurrent material edit.`,
					expected_version: source.version
				})
			);
			expect(() =>
				cli([
					'journal',
					'rewrite',
					`${project.name}/${issue.number}`,
					'--body',
					`@${join(FIXTURES, caseId, 'after.md')}`,
					'--expect-version',
					String(source.version),
					'--json'
				])
			).toThrow(/version_conflict|changed to version/i);
			const conflicted = await body<ContextItem>(await api.get(`/api/v1/context/${source.id}`));
			expect(conflicted.body).toBe(`${before}\nConcurrent material edit.`);
			record(caseId, 'source_cas_conflict_retained', 409, {
				command: 'tines journal rewrite',
				current_version: concurrent.version,
				body_retained: conflicted.body
			});
			await api.patch(`/api/v1/context/${source.id}`, {
				body: before,
				expected_version: concurrent.version
			});
		} else {
			const conflictSource = await body<ContextItem>(
				await api.post('/api/v1/context', {
					kind: 'prompt',
					name: `source-conflict-${caseId}-${runId}`,
					body: before,
					...scope
				})
			);
			const concurrent = await body<ContextItem>(
				await api.patch(`/api/v1/context/${conflictSource.id}`, {
					body: `${before}\nConcurrent material edit.`,
					expected_version: conflictSource.version
				})
			);
			const stale = await api.patch(`/api/v1/context/${conflictSource.id}`, {
				body: after,
				expected_version: conflictSource.version
			});
			expect(stale.status()).toBe(409);
			const conflictedBody = (
				await body<ContextItem>(await api.get(`/api/v1/context/${conflictSource.id}`))
			).body;
			expect(conflictedBody).toBe(`${before}\nConcurrent material edit.`);
			record(caseId, 'source_cas_conflict_retained', stale.status(), {
				current_version: concurrent.version,
				body_retained: conflictedBody
			});
			await api.delete(`/api/v1/context/${conflictSource.id}`);
		}

		const resumedSource = await body<ContextItem>(await api.get(`/api/v1/context/${source.id}`));
		const resumedDestination = await body<ContextItem>(
			await api.get(`/api/v1/context/${destination.id}`)
		);
		expect(resumedDestination.files).toContainEqual({ path: 'SKILL.md', content: skillBody });
		expect((await body<ContextItem>(await api.get(`/api/v1/context/${source.id}`))).body).toBe(
			before
		);
		record(caseId, 'resume_destination_complete_read', 'ok', {
			destination_id: resumedDestination.id,
			version: resumedDestination.version,
			files: resumedDestination.files?.map((file) => file.path)
		});
		const resumedEffective = await body<EffectiveContext>(
			await api.get(`/api/v1/issues/${issue.id}/context`)
		);
		expect(
			resumedEffective.skills.find((skill) => skill.name === 'planning-procedures')?.item_id
		).toBe(destination.id);
		expect((await body<ContextItem>(await api.get(`/api/v1/context/${source.id}`))).body).toBe(
			before
		);
		record(caseId, 'resume_effective_resolution', 'ok', {
			winner: destination.id,
			inherited_from: resumedEffective.skills.find((skill) => skill.name === 'planning-procedures')
				?.inherited_from
		});
		const resumeExportDir = mkdtempSync(join(tmpdir(), `tines-528-resume-${caseId}-`));
		cli(['issues', 'context', `${project.name}/${issue.number}`, '--out', resumeExportDir]);
		expect(readFileSync(join(resumeExportDir, 'skills/planning-procedures/SKILL.md'), 'utf8')).toBe(
			skillBody
		);
		expect((await body<ContextItem>(await api.get(`/api/v1/context/${source.id}`))).body).toBe(
			before
		);
		record(caseId, 'resume_fresh_directory_export', 'ok', {
			path: 'skills/planning-procedures/SKILL.md'
		});

		let applied: ContextItem;
		if (caseId === 'combined') {
			const shown = JSON.parse(
				cli(['journal', 'show', `${project.name}/${issue.number}`, '--json'])
			) as ContextItem;
			expect(shown).toMatchObject({ id: source.id, version: resumedSource.version, body: before });
			applied = JSON.parse(
				cli([
					'journal',
					'rewrite',
					`${project.name}/${issue.number}`,
					'--body',
					`@${join(FIXTURES, caseId, 'after.md')}`,
					'--expect-version',
					String(resumedSource.version),
					'--json'
				])
			) as ContextItem;
		} else {
			applied = await body<ContextItem>(
				await api.patch(`/api/v1/context/${source.id}`, {
					body: after,
					expected_version: resumedSource.version
				})
			);
		}
		record(caseId, 'source_cas', applied.version, {
			command: caseId === 'combined' ? 'tines journal rewrite' : 'PATCH /api/v1/context/:id',
			destination_version: resumedDestination.version,
			source_body: applied.body
		});
		expect(applied.body).toBe(after);
		const unneededDir = mkdtempSync(join(tmpdir(), `tines-528-unneeded-${caseId}-`));
		cli(['issues', 'context', `${project.name}/${issue.number}`, '--out', unneededDir]);
		const unneededReads: string[] = [];
		const unneededPrompt = (() => {
			unneededReads.push('prompt.md');
			return readFileSync(join(unneededDir, 'prompt.md'), 'utf8');
		})();
		expect(unneededPrompt).toContain(UNIVERSAL_MARKER[caseId]);
		expect(unneededPrompt).not.toContain(CONDITIONAL_MARKER[caseId]);
		expect(unneededReads).toEqual(['prompt.md']);
		record(caseId, 'unneeded_task_runtime_no_skill_read', 'ok', {
			task: `${caseId} supplied-brief summary`,
			reads: unneededReads,
			preserved_rule: UNIVERSAL_MARKER[caseId]
		});
		const orderedOperations = [
			'destination_write',
			'destination_complete_read',
			'effective_resolution',
			'fresh_directory_export',
			'needed_task_runtime_read',
			'resume_destination_complete_read',
			'resume_effective_resolution',
			'resume_fresh_directory_export',
			'source_cas'
		];
		const indexes = orderedOperations.map((operation) =>
			receipts.findIndex((receipt) => receipt.case === caseId && receipt.operation === operation)
		);
		expect(indexes.every((index) => index >= 0)).toBe(true);
		expect(indexes).toEqual([...indexes].sort((left, right) => left - right));

		const replayDestination = await body<ContextItem>(
			await api.get(`/api/v1/context/${destination.id}`)
		);
		const replaySource = await body<ContextItem>(await api.get(`/api/v1/context/${source.id}`));
		expect(replayDestination.version).toBe(destination.version);
		expect(replaySource.version).toBe(applied.version);
		record(caseId, 'replay_complete_no_version_bump', 'ok', {
			destination_version: replayDestination.version,
			source_version: replaySource.version
		});
		await api.delete(`/api/v1/context/${destination.id}`);
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
