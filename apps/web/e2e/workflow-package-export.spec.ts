import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	canonicalizeLibraryValue,
	parseLibraryV3Document,
	type ContextItem,
	type EffectiveContext,
	type CreateIssueResponse,
	type Project,
	type WorkflowPackageDocument,
	type WorkflowResponse
} from '@tines/shared';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { d1, sqlLiteral } from './d1';
import { ALICE, BASE_URL, BOB } from './constants.mjs';
import { apiClient, body, DESKTOP, gotoHydrated, PHONE, readSettled, signIn } from './helpers';

let name: string;
let dependencyName: string;
let projectName: string;
let scheduleName: string;
const literal = 'The ordinary prose marker stays exactly unchanged.';
const markdownTail = 'The final Markdown passage is visible only after expansion.';
const imageUrl = 'https://example.invalid/auto-fetch.png';
const IMPLEMENTATION_JARGON =
	/candidate-only|in this candidate only|candidate rebuilt|edit candidate text|input declaration|registered tokens|save candidate text|prepared plan|signed plan identity|a different digest is refused/i;
const longMarkdown = `# Long guidance

![remote pixel](${imageUrl})

${Array.from({ length: 92 }, (_, index) => `guidance${index + 1}`).join(' ')}

\`\`\`text
${Array.from({ length: 24 }, (_, index) => `fenced${index + 1}`).join(' ')}
\`\`\`

[Reviewed destination](https://example.invalid/never-fetch) ${markdownTail}`;
const longText = `alpha    beta
line two
${Array.from({ length: 125 }, (_, index) => `plain${index + 1}`).join(' ')}`;
let workflowId: string;
let sourceDependencyId: string;
let sourceConventionsId: string;
let projectId: string;
let scheduleId: string;
async function openExport(page: Page) {
	await gotoHydrated(page, `/workflows/${workflowId}/export?download=1`);
	await expect(page.getByRole('heading', { name: 'Workflow graph and gates' })).toBeVisible();
	await page.getByText('Add automation (optional)', { exact: true }).click();
	await page.getByText('Customize instructions and variables (optional)', { exact: true }).click();
}

async function expectPlainLanguage(page: Page) {
	const text = (await page.locator('body').innerText()).replace(/\s+/g, ' ').trim();
	expect(text).not.toMatch(IMPLEMENTATION_JARGON);
}

async function rebuildCandidate(page: Page) {
	const rebuild = page.getByRole('button', { name: 'Apply automation' });
	const rebuilt = page.waitForResponse(
		(response) =>
			new URL(response.url()).pathname === `/api/v1/workflows/${workflowId}/export` &&
			response.request().method() === 'GET' &&
			response.ok()
	);
	await rebuild.click();
	await (await rebuilt).finished();
	await page.evaluate(
		() =>
			new Promise<void>((resolve) =>
				requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
			)
	);
	await expect(rebuild).toBeEnabled();
}

function candidateInputs(page: Page) {
	return page.getByRole('region', { name: 'Variables and places used' });
}

function declaredInput(page: Page, key: string) {
	return candidateInputs(page).getByRole('button', { name: new RegExp(`^${key} ·`) });
}

function passageSection(page: Page, fieldLabel: string) {
	return page.locator(`section[aria-label="${fieldLabel}"]`);
}

/** Select `phrase` in the passage editor beside `fieldLabel`, then bind it to the declared `key`. */
async function useVariableInline(page: Page, fieldLabel: string, phrase: string, key: string) {
	const passage = passageSection(page, fieldLabel);
	if ((await passage.getByRole('textbox', { name: fieldLabel }).count()) === 0)
		await passage.getByRole('button', { name: `Edit ${fieldLabel}`, exact: true }).click();
	const editor = passage.getByRole('textbox', { name: fieldLabel });
	await editor.evaluate((node: HTMLTextAreaElement, needle: string) => {
		const start = node.value.indexOf(needle);
		node.focus();
		node.setSelectionRange(start, start + needle.length, 'forward');
		node.dispatchEvent(new Event('select', { bubbles: true }));
	}, phrase);
	await passage.getByRole('button', { name: 'Make variable' }).click();
	const choice = passage.locator('select:has(option[value="new"])');
	const value = await choice.locator('option', { hasText: ` · ${key} · ` }).getAttribute('value');
	await choice.selectOption(value!);
	await passage.getByRole('button', { name: 'Save', exact: true }).click();
	return passage;
}

async function reviewDependencies(page: Page) {
	for (const checkbox of await page
		.getByRole('checkbox', { name: /I reviewed (every file|this required repository)/ })
		.all())
		await checkbox.check();
}

test.beforeAll(async ({ apiFor, uniqueName }) => {
	name = uniqueName('Browser package', { maxLength: 100 });
	dependencyName = uniqueName('Browser dependency', { maxLength: 100 });
	projectName = uniqueName('Browser package project');
	scheduleName = uniqueName('Browser package schedule', { maxLength: 100 });
	const api = apiFor(ALICE);
	const dependency = await body<{ id: string; states: { id: string; name: string }[] }>(
		await api.post('/api/v1/workflows', {
			name: dependencyName,
			description: 'Required inherited browser evidence guidance.',
			initial_state: 'Conventions',
			states: [
				{ name: 'Conventions', category: 'active' },
				{ name: 'Complete', category: 'done' }
			],
			transitions: [{ name: 'Accept', from: 'Conventions', to: 'Complete' }]
		})
	);
	const conventions = dependency.states.find((state) => state.name === 'Conventions')!;
	sourceDependencyId = dependency.id;
	sourceConventionsId = conventions.id;
	await body(
		await api.post('/api/v1/context', {
			kind: 'prompt',
			name: 'inherited-first',
			workflow_state_id: conventions.id,
			body: 'Read this inherited dependency before the local browser instructions.'
		})
	);
	const workflow = await body<{ id: string; states: { id: string; name: string }[] }>(
		await api.post('/api/v1/workflows', {
			name,
			description: 'A browser-authored portable workflow.',
			initial_state: 'Draft',
			states: [
				{ name: 'Draft', category: 'active', inherits_from: conventions.id },
				{ name: 'Review', category: 'active' },
				{ name: 'Done', category: 'done' }
			],
			transitions: [
				{
					name: 'Finish',
					from: 'Draft',
					to: 'Done',
					requires: [{ artifact: 'report', type: 'text', content_type: 'text/markdown' }]
				}
			]
		})
	);
	workflowId = workflow.id;
	const draft = workflow.states.find((state) => state.name === 'Draft')!;
	const review = workflow.states.find((state) => state.name === 'Review')!;
	await body(
		await api.post('/api/v1/context', {
			kind: 'prompt',
			name: 'instructions',
			workflow_state_id: draft.id,
			body: `Replace TARGET only. Another TARGET remains ordinary prose. ${literal} Literal token-like text {{not_declared:value}} also stays. Escaped literal \\{{target_name:TARGET}} stays.`
		})
	);
	await body(
		await api.post('/api/v1/context', {
			kind: 'prompt',
			name: 'long-guide',
			workflow_state_id: draft.id,
			body: longMarkdown
		})
	);
	await body(
		await api.post('/api/v1/context', {
			kind: 'skill',
			name: 'browser-check',
			workflow_state_id: draft.id,
			files: [
				{ path: 'SKILL.md', content: '# Browser check\n\nUse the exact viewport.' },
				{ path: 'notes.txt', content: longText }
			]
		})
	);
	await body(
		await api.post('/api/v1/context', {
			kind: 'skill',
			name: 'qa-handoff',
			workflow_state_id: draft.id,
			files: [
				{
					path: 'SKILL.md',
					content: '# QA handoff\n\nAttach the evidence and use the gated transition.'
				},
				{ path: 'checklist.txt', content: 'inspect\nverify\nhandoff\n' }
			]
		})
	);
	await body(
		await api.post('/api/v1/context', {
			kind: 'repo',
			name: 'source',
			workflow_state_id: draft.id,
			repo_url: 'https://github.com/tbuckley/tines',
			repo_branch: 'main',
			repo_dir: null
		})
	);
	const project = await body<Project>(
		await api.post('/api/v1/projects', { name: projectName, default_workflow_id: workflow.id })
	);
	projectId = project.id;
	const issue = await body<CreateIssueResponse>(
		await api.post(`/api/v1/projects/${projectId}/issues`, {
			title: 'Scheduled title {{count}}',
			description: '**Scheduled description** for {{schedule_name}}.',
			workflow_id: workflow.id,
			state: review.id,
			schedule: {
				name: scheduleName,
				preset: { kind: 'daily', time: '05:00' },
				timezone: 'Europe/Dublin',
				require_all_closed: true
			}
		})
	);
	scheduleId = issue.schedule!.id;
});

test.beforeEach(async ({ context }) => signIn(context, ALICE.sessionToken));

for (const { viewport, theme } of [
	{ viewport: DESKTOP, theme: 'light' },
	{ viewport: DESKTOP, theme: 'dark' },
	{ viewport: PHONE, theme: 'light' },
	{ viewport: PHONE, theme: 'dark' }
] as const) {
	test(`corrects an authored input without rebuilding at ${viewport.width}px in ${theme} mode`, async ({
		page
	}) => {
		test.setTimeout(120_000);
		await page.setViewportSize(viewport);
		await page.addInitScript(
			(savedTheme) => localStorage.setItem('tines:theme', savedTheme),
			theme
		);
		await openExport(page);
		await expect(page.locator('html')).toHaveClass(
			theme === 'dark' ? /\bdark\b/ : /^(?!.*\bdark\b)/
		);
		await expect(page.getByRole('button', { name: 'Edit candidate text' })).toHaveCount(0);

		await page.getByLabel('Key').fill('project_name');
		await page.getByLabel('Type').selectOption('project');
		await page.getByLabel('Default').fill('customer-portal');
		await page.getByRole('button', { name: 'Add variable' }).click();
		await expect(page.getByText('Variable added to this copy.').first()).toBeVisible();
		await expect(page.getByText('Input declaration added to this candidate only.')).toHaveCount(0);
		await useVariableInline(page, 'instructions — prompt body', 'TARGET', 'project_name');

		await page.getByLabel('Key').fill('review_label');
		await page.getByLabel('Type').selectOption('label');
		await page.getByLabel('Default').fill('customer-reveiw');
		await page.getByRole('textbox', { name: 'Label', exact: true }).fill('Review label');
		await page.getByRole('button', { name: 'Add variable' }).click();
		await reviewDependencies(page);

		// Preserve a separate unfinished add draft through the correction.
		await page.getByLabel('Key').fill('pending_input');
		await page.getByLabel('Default').fill('pending-value');
		await page.getByRole('button', { name: 'Edit variable review_label' }).click();
		await expect(page.getByLabel('Key')).toBeFocused();
		await expect(
			page.getByRole('heading', { name: 'Editing variable review_label' })
		).toBeVisible();
		await expect(page.getByRole('button', { name: 'Apply automation' })).toBeDisabled();
		await expect(page.getByRole('button', { name: 'Edit variable project_name' })).toBeDisabled();
		await expect(page.getByRole('button', { name: 'Apply automation' })).toHaveAttribute(
			'title',
			'Save or cancel the variable edit before applying automation.'
		);
		await page.getByLabel('Key').fill('approval_label');
		await page.getByLabel('Type').selectOption('text');
		await page.getByRole('textbox', { name: 'Label', exact: true }).fill('Approval label');
		await page
			.getByRole('textbox', { name: 'Description' })
			.fill('Label applied after customer approval.');
		await page.getByLabel('Default').fill('customer-review');
		await page.getByRole('checkbox', { name: 'Required', exact: true }).check();
		await page.getByRole('button', { name: 'Save changes' }).click();

		await expect(page.getByRole('button', { name: 'Edit variable approval_label' })).toBeFocused();
		await expect(page.getByLabel('Key')).toHaveValue('pending_input');
		await expect(page.getByLabel('Default')).toHaveValue('pending-value');
		await expect(declaredInput(page, 'approval_label')).toHaveAttribute('aria-pressed', 'true');
		await expect(page.getByText('Variable updated in this copy.').first()).toBeVisible();
		await expectPlainLanguage(page);
		await expect(page.getByRole('button', { name: 'Download file' })).toBeDisabled();
		for (const checkbox of await page
			.getByRole('checkbox', { name: /I reviewed (every file|this required repository)/ })
			.all())
			await expect(checkbox).not.toBeChecked();
		const projectChip = page.locator('[data-input-id]').filter({ hasText: 'project_name · 1 use' });
		await expect(projectChip).toBeVisible();
		await expect(projectChip.locator('span').first()).toHaveText('customer-portal');
		await expect(projectChip.getByRole('button', { name: 'Edit project_name' })).toBeVisible();

		const editButton = page.getByRole('button', { name: 'Edit variable approval_label' });
		await expect(editButton.locator('svg')).toBeVisible();
		await expect(editButton).toHaveText('');
		const editBox = await editButton.boundingBox();
		const declarationBox = await page.locator('#input-input\\:author\\:2').boundingBox();
		expect(editBox?.height).toBeGreaterThanOrEqual(40);
		expect(editBox?.width).toBe(editBox?.height);
		expect(
			Math.abs(
				(editBox?.y ?? 0) +
					(editBox?.height ?? 0) / 2 -
					((declarationBox?.y ?? 0) + (declarationBox?.height ?? 0) / 2)
			)
		).toBeLessThanOrEqual(1);
		const overflow = await page.evaluate(() =>
			[...globalThis.document.querySelectorAll<HTMLElement>('*')]
				.filter((element) => element.getBoundingClientRect().right > window.innerWidth + 1)
				.map((element) => `${element.tagName}.${element.className}`)
		);
		expect(overflow).toEqual([]);

		await reviewDependencies(page);
		const downloadPromise = page.waitForEvent('download');
		await page.getByRole('button', { name: 'Download file' }).click();
		const path = await (await downloadPromise).path();
		const source = await (await import('node:fs/promises')).readFile(path!, 'utf8');
		const downloaded = (await parseLibraryV3Document(source)) as WorkflowPackageDocument;
		expect(downloaded.inputs.map(({ id, key }) => ({ id, key }))).toEqual([
			{ id: 'input:author:1', key: 'project_name' },
			{ id: 'input:author:2', key: 'approval_label' }
		]);
		expect(downloaded.inputs[1]).toEqual({
			id: 'input:author:2',
			key: 'approval_label',
			type: 'text',
			label: 'Approval label',
			description: 'Label applied after customer approval.',
			required: true,
			default: 'customer-review'
		});
		expect(downloaded.text_uses).toEqual([
			expect.objectContaining({
				input_id: 'input:author:1',
				token: '{{project_name:customer-portal}}'
			})
		]);
	});
}

test('creates and previews one exact occurrence beside its passage', async ({ page }) => {
	await openExport(page);
	const passage = page.locator('section[aria-label="instructions — prompt body"]');
	await passage
		.getByRole('button', { name: 'Edit instructions — prompt body', exact: true })
		.click();
	const editor = passage.getByRole('textbox', { name: 'instructions — prompt body' });
	await editor.fill('Deploy customer-portal, but keep customer-portal private.');
	await editor.evaluate((node: HTMLTextAreaElement) => {
		const start = node.value.indexOf('customer-portal');
		node.focus();
		node.setSelectionRange(start, start + 'customer-portal'.length, 'forward');
		node.dispatchEvent(new Event('select', { bubbles: true }));
	});
	await passage.getByRole('button', { name: 'Make variable' }).click();
	await passage.getByRole('textbox', { name: 'Friendly name' }).fill('Project name');
	await passage.getByRole('button', { name: 'Save', exact: true }).click();

	const chip = passage.locator('[data-input-id]');
	const chipValue = chip.locator('span').first();
	await expect(chip.getByRole('button', { name: 'Edit Project name' })).toBeFocused();
	await expect(chip).toContainText('Project name · 1 use');
	await expect(chipValue).toHaveText('customer-portal');
	await expect(passage.getByText('keep customer-portal private', { exact: false })).toBeVisible();
	await expect(passage).not.toContainText('{{project_name:customer-portal}}');

	await passage.getByRole('button', { name: 'Preview values' }).click();
	await passage
		.getByRole('textbox', { name: 'Sample value — Project name' })
		.fill('support-console');
	await expect(chipValue).toHaveText('support-console');
	await expect(passage.getByText('keep customer-portal private', { exact: false })).toBeVisible();
	// A Markdown-valued sample splits into styled fragments but stays one occurrence:
	// one chip, one Edit control, one id.
	await passage.getByRole('textbox', { name: 'Sample value — Project name' }).fill('a **b** c');
	await expect(chip).toHaveCount(1);
	await expect(chipValue).toHaveText('a b c');
	await expect(chipValue.locator('.font-bold')).toHaveText('b');
	await expect(chip.getByRole('button', { name: 'Edit Project name' })).toHaveCount(1);
	await expect(passage).not.toContainText('**b**');
	expect(
		await passage.evaluate((section) => {
			const ids = [...section.querySelectorAll('[id]')].map((node) => node.id);
			return ids.length - new Set(ids).size;
		})
	).toBe(0);
	for (const name of ['Preview values', 'Use default'])
		expect(
			(await passage.getByRole('button', { name }).boundingBox())!.height
		).toBeGreaterThanOrEqual(44);
	await passage.getByRole('button', { name: 'Use default' }).click();
	await expect(chipValue).toHaveText('customer-portal');

	await chip.getByRole('button', { name: 'Edit Project name' }).click();
	await passage.getByRole('textbox', { name: 'Friendly name' }).fill('Service name');
	await passage.getByText('More options', { exact: true }).click();
	await passage.getByLabel('Example/default').fill('billing-service');
	await passage.getByRole('button', { name: 'Done' }).click();
	await expect(chip.getByRole('button', { name: 'Edit Service name' })).toBeFocused();
	await expect(page.getByText('Variable updated in this copy.').first()).toBeVisible();
	await expectPlainLanguage(page);
	await expect(chip).toContainText('Service name · 1 use');
	await expect(chipValue).toHaveText('billing-service');

	// A bare Edit/Preview toggle changes no bytes, so review acknowledgments survive it.
	await reviewDependencies(page);
	const download = page.getByRole('button', { name: 'Download file' });
	await expect(download).toBeEnabled();
	const editToggle = passage.getByRole('button', {
		name: 'Edit instructions — prompt body',
		exact: true
	});
	await editToggle.click();
	await passage
		.getByRole('button', { name: 'Preview instructions — prompt body', exact: true })
		.click();
	await expect(download).toBeEnabled();

	// Escape cancels an open form and returns focus to the editor with its selection.
	await editToggle.click();
	await editor.evaluate((node: HTMLTextAreaElement) => {
		const start = node.value.indexOf('private');
		node.focus();
		node.setSelectionRange(start, start + 'private'.length, 'forward');
		node.dispatchEvent(new Event('select', { bubbles: true }));
	});
	await passage.getByRole('button', { name: 'Make variable' }).click();
	await expect(passage.getByRole('group', { name: 'Make variable' })).toBeVisible();
	await page.keyboard.press('Escape');
	await expect(passage.getByRole('textbox', { name: 'Friendly name' })).toHaveCount(0);
	await expect(editor).toBeFocused();
	// The editor holds source text, so the retained range is measured against its own value.
	const retained = await editor.evaluate((node: HTMLTextAreaElement) => ({
		start: node.selectionStart,
		end: node.selectionEnd,
		expected: node.value.indexOf('private')
	}));
	expect(retained.expected).toBeGreaterThan(0);
	expect([retained.start, retained.end]).toEqual([
		retained.expected,
		retained.expected + 'private'.length
	]);
});

test('cancels safely and refuses duplicate keys or registered-token edits over unsaved text', async ({
	page
}) => {
	await openExport(page);
	await page.getByLabel('Source project').selectOption(projectId);
	await page.getByRole('checkbox', { name: new RegExp(scheduleName) }).check();
	await page.getByRole('button', { name: 'Apply automation' }).click();
	await expect(page.getByRole('button', { name: /destination_project · project/ })).toBeVisible();
	await expect(page.getByRole('button', { name: 'Edit variable destination_project' })).toHaveCount(
		0
	);

	await page.getByLabel('Key').fill('first_input');
	await page.getByLabel('Default').fill('before');
	await page.getByRole('button', { name: 'Add variable' }).click();
	const passage = await useVariableInline(
		page,
		'instructions — prompt body',
		'TARGET',
		'first_input'
	);
	await page.getByLabel('Key').fill('second_input');
	await page.getByLabel('Default').fill('second');
	await page.getByRole('button', { name: 'Add variable' }).click();
	const selectedDeclaration = page.locator('button[id^="input-"]').filter({
		hasText: 'second_input'
	});
	await selectedDeclaration.click();
	await expect(selectedDeclaration).toHaveAttribute('aria-pressed', 'true');
	await reviewDependencies(page);

	await page.getByLabel('Key').fill('pending_input');
	await page.getByLabel('Default').fill('pending');
	await page.getByRole('button', { name: 'Edit variable first_input' }).click();
	await page.getByLabel('Key').fill('second_input');
	await page.getByRole('button', { name: 'Save changes' }).click();
	await expect(page.getByRole('alert')).toHaveText('Variable key “second_input” already exists.');
	for (const checkbox of await page
		.getByRole('checkbox', { name: /I reviewed (every file|this required repository)/ })
		.all())
		await expect(checkbox).toBeChecked();
	await page.getByRole('button', { name: 'Cancel', exact: true }).click();
	await expect(selectedDeclaration).toHaveAttribute('aria-pressed', 'true');
	await expect(page.getByRole('button', { name: 'Edit variable first_input' })).toBeFocused();
	await expect(page.getByLabel('Key')).toHaveValue('pending_input');
	await expect(page.getByLabel('Default')).toHaveValue('pending');

	await passage
		.getByRole('button', { name: 'Edit instructions — prompt body', exact: true })
		.click();
	const editor = passage.getByRole('textbox', { name: 'instructions — prompt body' });
	const unsaved = `${await editor.inputValue()} Unsaved adjacent prose.`;
	await editor.fill(unsaved);
	await page.getByRole('button', { name: 'Edit variable first_input' }).click();
	await page.getByLabel('Default').fill('after');
	await page.getByRole('button', { name: 'Save changes' }).click();
	await expect(page.getByRole('alert')).toHaveText(
		'Save text before changing this variable’s key or default.'
	);
	await expect(editor).toHaveValue(unsaved);
	await expect(page.getByLabel('Default')).toHaveValue('after');
	await passage.getByRole('button', { name: 'Save text', exact: true }).click();
	await expect(passage).toContainText('Unsaved adjacent prose.');
	await page.getByRole('button', { name: 'Save changes' }).click();
	await expect(selectedDeclaration).toHaveAttribute('aria-pressed', 'true');
	await expect(page.getByRole('button', { name: 'Edit variable first_input' })).toBeFocused();
	await expect(passage.locator('[data-input-id]').locator('span').first()).toHaveText('after');
	await expect(passage).toContainText('Unsaved adjacent prose.');
	const applyAutomation = page.getByRole('button', { name: 'Apply automation' });
	await expect(applyAutomation).toBeEnabled();
	await expectPlainLanguage(page);

	const dismissedDialog = page.waitForEvent('dialog');
	const dismissedClick = applyAutomation.click();
	const firstDialog = await dismissedDialog;
	expect(firstDialog.message()).toBe(
		'Apply automation using the latest workflow? This replaces the instruction and variable edits made in this copy.'
	);
	await firstDialog.dismiss();
	await dismissedClick;
	await expect(passage).toContainText('Unsaved adjacent prose.');

	const acceptedDialog = page.waitForEvent('dialog');
	const acceptedClick = applyAutomation.click();
	const secondDialog = await acceptedDialog;
	expect(secondDialog.message()).toBe(firstDialog.message());
	await secondDialog.accept();
	await acceptedClick;
	await expect(
		page.getByText('This copy now uses the latest workflow and automation choices.').first()
	).toBeVisible();
	await expectPlainLanguage(page);
});

test('authors an exact declared use and downloads the reviewed canonical package', async ({
	page,
	request,
	uniqueName
}) => {
	test.setTimeout(120_000);
	await page.setViewportSize(DESKTOP);
	const externalRequests: string[] = [];
	page.on('request', (request) => {
		if (new URL(request.url()).origin !== BASE_URL) externalRequests.push(request.url());
	});
	await gotoHydrated(page, `/workflows/${workflowId}`);
	await page.getByRole('link', { name: 'Export package' }).click();
	await expect(page).toHaveURL(`/workflows/${workflowId}/export?download=1`);
	await expect(page.getByRole('heading', { name: 'Workflow graph and gates' })).toBeVisible();
	await page.getByText('Add automation (optional)', { exact: true }).click();
	await page.getByText('Customize instructions and variables (optional)', { exact: true }).click();
	await expect(page.getByText('report · text · text/markdown')).toBeVisible();
	await expect(page.getByText(literal, { exact: false })).toBeVisible();
	// The acceptance file carries optional automation, but the first installation
	// intentionally omits it to prove the project-free path.
	await page.getByLabel('Source project').selectOption(projectId);
	await page.getByRole('checkbox', { name: new RegExp(scheduleName) }).check();
	await page.getByText('Routing preferences (optional)').click();
	const draftTier = page
		.locator('div.rounded-md')
		.filter({ hasText: `${name} › Draft` })
		.last();
	await draftTier.locator('select').selectOption('balanced');
	await draftTier.getByRole('checkbox', { name: 'Project-scoped' }).check();
	await page.getByRole('button', { name: 'Apply automation' }).click();
	await page.getByLabel('Key').fill('target_workflow');
	await page.getByLabel('Type').selectOption('workflow');
	await page.getByLabel('Default').fill('Standard');
	await page.getByRole('textbox', { name: 'Label', exact: true }).fill('Target workflow');
	await page.getByRole('button', { name: 'Add variable' }).click();
	const targetWorkflow = declaredInput(page, 'target_workflow');
	await expect(targetWorkflow).toHaveAttribute('aria-pressed', 'true');
	await expect(candidateInputs(page).getByText('Selected', { exact: true })).toHaveCount(1);
	await page.getByLabel('Key').fill('target_name');
	await page.getByLabel('Type').selectOption('text');
	await page.getByLabel('Default').fill('TARGET');
	await page.getByRole('textbox', { name: 'Label', exact: true }).fill('Target name');
	await page.getByRole('button', { name: 'Add variable' }).click();
	const targetName = declaredInput(page, 'target_name');
	await expect(targetWorkflow).toHaveAttribute('aria-pressed', 'false');
	await expect(targetName).toHaveAttribute('aria-pressed', 'true');
	const reviewedCheckbox = page
		.getByRole('checkbox', { name: /I reviewed (every file|this required repository)/ })
		.first();
	await reviewedCheckbox.check();
	await targetWorkflow.click();
	await expect(targetWorkflow).toHaveAttribute('aria-pressed', 'true');
	await expect(targetName).toHaveAttribute('aria-pressed', 'false');
	await expect(reviewedCheckbox).toBeChecked();
	const passage = await useVariableInline(
		page,
		'instructions — prompt body',
		'TARGET',
		'target_name'
	);
	const token = passage.locator('[data-input-id]');
	await expect(token).toBeVisible();
	await expect(token.locator('span').first()).toHaveText('TARGET');
	await expect(token).toContainText('Target name · 1 use');
	// The escaped literal renders as ordinary text: exactly one substitutable use.
	await expect(token).toHaveCount(1);
	await expect(passage.getByText('Escaped literal {{target_name:TARGET}} stays.')).toBeVisible();
	await token.getByRole('button', { name: 'Edit Target name' }).click();
	await expect(passage.getByRole('textbox', { name: 'Friendly name' })).toBeVisible();
	await passage.getByRole('button', { name: 'Cancel', exact: true }).click();
	await expect(passage.getByRole('textbox', { name: 'Friendly name' })).toHaveCount(0);
	await expect(page.getByRole('button', { name: 'Download file' })).toBeDisabled();
	await reviewDependencies(page);
	const downloadPromise = page.waitForEvent('download');
	await page.getByRole('button', { name: 'Download file' }).click();
	const download = await downloadPromise;
	const path = await download.path();
	const source = await (await import('node:fs/promises')).readFile(path!, 'utf8');
	const document = (await parseLibraryV3Document(source)) as WorkflowPackageDocument;
	expect(source).toBe(`${canonicalizeLibraryValue(document)}\n`);
	expect(document.digest).toMatch(/^sha256:[a-f0-9]{64}$/);
	expect(document.inputs.find((input) => input.key === 'target_name')?.default).toBe('TARGET');
	expect(document.text_uses).toHaveLength(1);
	const prompt = document.context.find(
		(item) => item.kind === 'prompt' && item.name === 'instructions'
	);
	expect(prompt?.kind === 'prompt' ? prompt.body : '').toContain(literal);
	expect(prompt?.kind === 'prompt' ? prompt.body : '').toContain('{{not_declared:value}}');
	expect(prompt?.kind === 'prompt' ? prompt.body : '').toContain(
		'Escaped literal \\{{target_name:TARGET}} stays.'
	);

	// Alice's exact browser download is Bob's browser input without conversion.
	const directory = mkdtempSync(join(tmpdir(), 'tines-browser-package-'));
	const packagePath = join(directory, 'package.json');
	writeFileSync(packagePath, source);
	await signIn(page.context(), BOB.sessionToken);
	await gotoHydrated(page, '/workflows/import');
	await page.getByLabel('Workflow package file').setInputFiles(packagePath);
	await page.getByLabel('Target workflow').selectOption({ label: 'Standard' });
	await page.getByLabel('Target name').fill('DESTINATION');
	await page.getByLabel(`Main · ${name}`).fill(`${name} installed`);
	await page.getByRole('button', { name: 'Preview installation' }).click();
	await expect(page.getByRole('heading', { name: 'Workflow graph and gates' })).toBeVisible();
	await expect(page.getByText('Replace DESTINATION only.', { exact: false }).first()).toBeVisible();
	await expect(
		page.getByText('Another TARGET remains ordinary prose.', { exact: false }).first()
	).toBeVisible();
	for (const checkbox of await page
		.getByTestId('package-review')
		.getByRole('checkbox', { name: /I reviewed/ })
		.all())
		await checkbox.check();
	await page.getByRole('checkbox', { name: /I reviewed what will be installed/ }).check();

	// The signed plan is actor-bound. A wrong-actor rejection is a definite rollback,
	// leaving the same reviewed plan available to its owner.
	await signIn(page.context(), ALICE.sessionToken);
	await page.getByRole('button', { name: 'Install workflow' }).click();
	await expect(page.getByRole('alert')).toContainText(
		'Installation did not finish. Your reviewed choices are still available. Choose Install workflow to retry.'
	);
	await expect(page.locator('[data-package-receipt]')).toHaveCount(0);

	// Change Bob's destination after preparation. The backend must reject the stale
	// witness without installing, and the browser must require a fresh preview and confirmation.
	await signIn(page.context(), BOB.sessionToken);
	const bobApi = apiClient(request, BOB.apiKey);
	await body(
		await bobApi.post('/api/v1/workflows', {
			name: `${name} installed`,
			description: 'Collision created after package preparation.',
			initial_state: 'Existing',
			states: [{ name: 'Existing', category: 'active' }],
			transitions: []
		})
	);
	await page.getByRole('button', { name: 'Install workflow' }).click();
	await expect(
		page.getByText('Choose Preview installation and review it again.', { exact: false })
	).toBeVisible();
	await expect(page.locator('[data-package-receipt]')).toHaveCount(0);
	await page.getByLabel(`Main · ${name}`).fill(`${name} installed reviewed`);
	await page.getByRole('button', { name: 'Preview installation' }).click();
	await expect(page.getByRole('heading', { name: 'Workflow graph and gates' })).toBeVisible();
	for (const checkbox of await page
		.getByTestId('package-review')
		.getByRole('checkbox', { name: /I reviewed/ })
		.all())
		if (!(await checkbox.isChecked())) await checkbox.check();
	await expect(
		page.getByRole('checkbox', { name: /I reviewed what will be installed/ })
	).not.toBeChecked();
	await page.getByRole('checkbox', { name: /I reviewed what will be installed/ }).check();
	await page.getByRole('button', { name: 'Install workflow' }).click();
	await expect(page.getByRole('heading', { name: 'Installed', exact: true })).toBeFocused();
	const installedPromptHref = await page
		.getByText('prompt · instructions', { exact: true })
		.locator('..')
		.getByRole('link')
		.getAttribute('href');
	expect(installedPromptHref).toMatch(/^\/context\?workflow=wf_/);
	const installedWorkflowHref = await page
		.getByText(`workflow · ${name} installed reviewed · main`, { exact: true })
		.locator('..')
		.getByRole('link')
		.getAttribute('href');
	expect(installedWorkflowHref).toMatch(/^\/workflows\/wf_/);
	const installedWorkflow = await body<WorkflowResponse>(
		await bobApi.get(`/api/v1${installedWorkflowHref!}`)
	);
	const installedContexts = (
		await Promise.all(
			installedWorkflow.states.map(async (state) =>
				body<{ items: ContextItem[] }>(await bobApi.get(`/api/v1/context?state=${state.id}`))
			)
		)
	).flatMap((result) => result.items);
	const copied = installedContexts.find((item) => item.name === 'instructions');
	expect(copied).toBeTruthy();
	expect(copied!.body).toContain('Replace DESTINATION only.');
	expect(copied!.body).toContain('Another TARGET remains ordinary prose.');
	expect(copied!.body).toContain(literal);
	expect(copied!.body).toContain('{{not_declared:value}}');
	expect(copied!.body).toContain('Escaped literal {{target_name:TARGET}} stays.');
	expect(copied!.body).not.toContain('DESTINATION}}');
	// Inspect the installed graph and exact gate, not merely Alice's source proof.
	const installedDraft = installedWorkflow.states.find((state) => state.name === 'Draft')!;
	const dependencyHref = await page
		.getByText(`workflow · ${dependencyName} · dependency`, { exact: true })
		.locator('..')
		.getByRole('link')
		.getAttribute('href');
	const installedDependency = await body<WorkflowResponse>(
		await bobApi.get(`/api/v1${dependencyHref}`)
	);
	const installedConventions = installedDependency.states.find(
		(state) => state.name === 'Conventions'
	)!;
	expect(installedDraft.inherits_from).toBe(installedConventions.id);
	expect(installedWorkflow.id).not.toBe(workflowId);
	expect(installedDependency.id).not.toBe(sourceDependencyId);
	expect(installedConventions.id).not.toBe(sourceConventionsId);
	const finish = installedWorkflow.transitions.find((transition) => transition.name === 'Finish')!;
	expect(finish).toMatchObject({
		from_state_id: installedDraft.id,
		to_state_id: installedWorkflow.states.find((state) => state.name === 'Done')!.id,
		requires: [{ artifact: 'report', type: 'text', content_type: 'text/markdown' }]
	});
	const copiedSkill = installedContexts.find((item) => item.name === 'browser-check')!;
	const skill = await body<ContextItem>(await bobApi.get(`/api/v1/context/${copiedSkill.id}`));
	expect(skill.files).toEqual([
		{ path: 'SKILL.md', content: '# Browser check\n\nUse the exact viewport.' },
		{ path: 'notes.txt', content: longText }
	]);
	const handoffSkill = await body<ContextItem>(
		await bobApi.get(
			`/api/v1/context/${installedContexts.find((item) => item.name === 'qa-handoff')!.id}`
		)
	);
	expect(handoffSkill.files).toEqual([
		{
			path: 'SKILL.md',
			content: '# QA handoff\n\nAttach the evidence and use the gated transition.'
		},
		{ path: 'checklist.txt', content: 'inspect\nverify\nhandoff\n' }
	]);
	const localPrompts = installedContexts
		.filter((item) => ['instructions', 'long-guide'].includes(item.name))
		.sort((a, b) => a.position - b.position);
	expect(localPrompts.map((item) => item.name)).toEqual(['instructions', 'long-guide']);
	expect(localPrompts[0].position).toBeLessThan(localPrompts[1].position);
	// First prove install created no issues/schedules. Only then explicitly create an
	// inspection issue, so the ordinary effective-context API can assemble inheritance.
	const workflowIds = [installedWorkflow.id, installedDependency.id].map(sqlLiteral).join(',');
	expect(d1(`SELECT id FROM issue WHERE workflow_id IN (${workflowIds})`)).toEqual([]);
	expect(d1(`SELECT id FROM scheduled_task WHERE workflow_id IN (${workflowIds})`)).toEqual([]);
	const inspectionProject = await body<Project>(
		await bobApi.post('/api/v1/projects', { name: uniqueName('Installed context inspection') })
	);
	const inspectionIssue = await body<CreateIssueResponse>(
		await bobApi.post(`/api/v1/projects/${inspectionProject.id}/issues`, {
			title: 'Explicit context inspection',
			workflow_id: installedWorkflow.id,
			state: installedDraft.id
		})
	);
	const effective = await body<EffectiveContext>(
		await bobApi.get(`/api/v1/issues/${inspectionIssue.id}/context`)
	);
	const parts = effective.prompt.parts.filter((part) =>
		['inherited-first', 'instructions', 'long-guide'].includes(part.name)
	);
	expect(parts.map((part) => part.name)).toEqual(['inherited-first', 'instructions', 'long-guide']);
	expect(parts[0]).toMatchObject({
		body: 'Read this inherited dependency before the local browser instructions.',
		inherited_from: { state_id: installedConventions.id, workflow_id: installedDependency.id }
	});
	expect(parts[1].body).toBe(copied!.body);
	expect(parts[2].body).toBe(longMarkdown);
	expect(effective.skills.find((item) => item.name === 'browser-check')?.files).toEqual(
		skill.files
	);
	expect(effective.repos.find((item) => item.name === 'source')).toMatchObject({
		url: 'https://github.com/tbuckley/tines',
		branch: 'main'
	});

	// The same reviewed file can create a second independent copy with its
	// optional schedule and tier enabled for exactly one destination project.
	const secondProject = await body<Project>(
		await bobApi.post('/api/v1/projects', { name: uniqueName('Installed context second') })
	);
	const secondInspectionIssue = await body<CreateIssueResponse>(
		await bobApi.post(`/api/v1/projects/${secondProject.id}/issues`, {
			title: 'Second-project context inspection',
			workflow_id: installedWorkflow.id,
			state: installedDraft.id
		})
	);
	const secondEffective = await body<EffectiveContext>(
		await bobApi.get(`/api/v1/issues/${secondInspectionIssue.id}/context`)
	);
	expect(
		secondEffective.prompt.parts
			.filter((part) => ['inherited-first', 'instructions', 'long-guide'].includes(part.name))
			.map((part) => part.name)
	).toEqual(['inherited-first', 'instructions', 'long-guide']);
	expect(secondEffective.skills.find((item) => item.name === 'browser-check')?.files).toEqual(
		skill.files
	);
	const defaultsBefore = [inspectionProject, secondProject].map((project) => ({
		id: project.id,
		default_workflow_id: project.default_workflow_id
	}));
	const runnerId = uniqueName('rnr_package_acceptance');
	const routingId = uniqueName('rrl_package_acceptance');
	const runnerName = uniqueName('Package acceptance');
	const now = Date.now();
	d1(`INSERT INTO runner(id,user_id,type,name,status,max_concurrent,max_run_minutes,default_tier,config,created_at,updated_at)
		VALUES(${sqlLiteral(runnerId)},${sqlLiteral(BOB.id)},'local',${sqlLiteral(runnerName)},'active',1,30,'balanced','{"harness":"codex"}',${now},${now});
		INSERT INTO routing_rule(id,user_id,project_id,workflow_state_id,label_id,targets,created_at,updated_at)
		VALUES(${sqlLiteral(routingId)},${sqlLiteral(BOB.id)},${sqlLiteral(inspectionProject.id)},NULL,NULL,${sqlLiteral(JSON.stringify([{ runner_id: runnerId }]))},${now},${now})`);
	await gotoHydrated(page, '/workflows/import');
	await page.getByLabel('Workflow package file').setInputFiles(packagePath);
	await page.getByLabel('Target workflow').selectOption({ label: 'Standard' });
	await page.getByLabel('Destination project').selectOption(inspectionProject.id);
	await page
		.getByRole('group', { name: 'Optional paused schedules' })
		.getByRole('checkbox', { name: scheduleName })
		.check();
	await page
		.getByRole('group', { name: 'Optional destination tier preferences' })
		.locator('select')
		.selectOption('balanced');
	await page.getByLabel(`Main · ${name}`).fill(`${name} scheduled copy`);
	await page.getByLabel(`Dependency · ${dependencyName}`).fill(`${dependencyName} scheduled copy`);
	await page.getByRole('button', { name: 'Preview installation' }).click();
	await expect(page.getByText('balanced for Draft in destination project')).toBeVisible();
	for (const checkbox of await page
		.getByTestId('package-review')
		.getByRole('checkbox', { name: /I reviewed/ })
		.all())
		await checkbox.check();
	await page.getByRole('checkbox', { name: /I reviewed what will be installed/ }).check();
	const installResponse = page.waitForResponse(
		(response) => response.url().endsWith('/api/v1/library/install') && response.ok()
	);
	await page.getByRole('button', { name: 'Install workflow' }).click();
	const secondReceipt = (await (await installResponse).json()) as {
		objects: Array<{ kind: string; relationship?: string; id: string }>;
		reused_inputs: Array<{ input_id: string; type: string; name: string }>;
	};
	expect(secondReceipt.reused_inputs).toEqual(
		expect.arrayContaining([
			expect.objectContaining({ type: 'workflow', name: 'Standard' }),
			expect.objectContaining({ type: 'project', name: inspectionProject.name })
		])
	);
	const secondMainId = secondReceipt.objects.find(
		(object) => object.kind === 'workflow' && object.relationship === 'main'
	)!.id;
	const secondDependencyId = secondReceipt.objects.find(
		(object) => object.kind === 'workflow' && object.relationship === 'dependency'
	)!.id;
	const installedScheduleId = secondReceipt.objects.find(
		(object) => object.kind === 'schedule'
	)!.id;
	expect(
		d1(
			`SELECT enabled,last_run_at,run_count,project_id FROM scheduled_task WHERE id=${sqlLiteral(installedScheduleId)}`
		)
	).toEqual([{ enabled: 0, last_run_at: null, run_count: 0, project_id: inspectionProject.id }]);
	expect(d1(`SELECT id FROM issue WHERE workflow_id=${sqlLiteral(secondMainId)}`)).toEqual([]);
	for (const before of defaultsBefore) {
		expect(d1(`SELECT default_workflow_id FROM project WHERE id=${sqlLiteral(before.id)}`)).toEqual(
			[{ default_workflow_id: before.default_workflow_id }]
		);
	}

	// Ordinary editing of one copied dependency cannot mutate Alice's source or
	// the other installed copy.
	await body(
		await bobApi.patch(`/api/v1/workflows/${installedDependency.id}`, {
			description: 'Edited only in the first independent copy.'
		})
	);
	expect(
		(await body<WorkflowResponse>(await bobApi.get(`/api/v1/workflows/${installedDependency.id}`)))
			.description
	).toBe('Edited only in the first independent copy.');
	expect(
		(await body<WorkflowResponse>(await bobApi.get(`/api/v1/workflows/${secondDependencyId}`)))
			.description
	).toBe('Required inherited browser evidence guidance.');
	const aliceApi = apiClient(request, ALICE.apiKey);
	expect(
		(await body<WorkflowResponse>(await aliceApi.get(`/api/v1/workflows/${sourceDependencyId}`)))
			.description
	).toBe('Required inherited browser evidence guidance.');
	// Ordinary receipt links remain navigable after the read-back inspection.
	expect((await bobApi.get(`/api/v1/context/${copiedSkill.id}`)).ok()).toBe(true);
	expect(externalRequests).toEqual([]);
	await page.evaluate(() => globalThis.scrollTo(0, 0));
	await page.screenshot({
		path: test.info().outputPath('workflow-package-desktop.png'),
		fullPage: true
	});
	await page.setViewportSize(PHONE);
	await page.emulateMedia({ reducedMotion: 'reduce' });
	const overflow = await page.evaluate(() =>
		[...globalThis.document.querySelectorAll<HTMLElement>('*')]
			.filter((element) => element.getBoundingClientRect().right > window.innerWidth + 1)
			.map((element) => `${element.tagName}.${element.className}`)
	);
	expect(overflow).toEqual([]);
	await page.evaluate(() => globalThis.scrollTo(0, 0));
	await page.screenshot({
		path: test.info().outputPath('workflow-package-phone.png'),
		fullPage: true
	});
});

test('reviews inheritance plus long Markdown and plain-text files without remote loads', async ({
	page
}) => {
	await page.setViewportSize(DESKTOP);
	const externalRequests: string[] = [];
	page.on('request', (request) => {
		if (new URL(request.url()).host === 'example.invalid') externalRequests.push(request.url());
	});
	await openExport(page);
	await expect(page.getByText('Required inheritance dependency')).toBeVisible();
	await expect(page.getByRole('heading', { name: `${name} › Draft` })).toBeVisible();
	await expect(
		page.getByRole('heading', { name: `${dependencyName} › Conventions` })
	).toBeVisible();
	await expect(page.getByText('Read this inherited dependency before')).toBeVisible();

	const markdownSection = page
		.getByRole('heading', { name: /^long-guide/ })
		.locator('..')
		.locator('..');
	await expect(markdownSection.getByRole('heading', { name: 'Long guidance' })).toBeVisible();
	await expect(markdownSection.locator('img')).toHaveCount(0);
	await expect(
		markdownSection.getByRole('img', { name: `Image not loaded: remote pixel — ${imageUrl}` })
	).toHaveText(`Image (not loaded): remote pixel — ${imageUrl}`);
	await expect(markdownSection.getByText(markdownTail)).toBeHidden();
	// The snippet stops at 100 rendered words, which lands before the fenced block here, so
	// the block renders as <pre><code> only once the passage is expanded.
	await expect(markdownSection.locator('pre code')).toHaveCount(0);
	await expect(markdownSection).not.toContainText('[content omitted]');
	const expandMarkdown = markdownSection.getByRole('button', { name: /Show all \d+ words/ });
	await expandMarkdown.click();
	await expect(page.getByText(markdownTail)).toBeVisible();
	await expect(markdownSection.locator('pre code')).toContainText('fenced24');
	const collapseMarkdown = markdownSection.getByRole('button', { name: 'Show snippet' });
	await expect(collapseMarkdown).toBeFocused();
	// Links open through the same confirm-destination dialog the public reader uses; the
	// destination is shown and only opened by an explicit click.
	const reviewedDestination = markdownSection.getByRole('button', {
		name: 'Reviewed destination'
	});
	await expect(reviewedDestination).toHaveAttribute(
		'title',
		'Open external destination: https://example.invalid/never-fetch'
	);
	await reviewedDestination.click();
	const destinationDialog = page.getByRole('dialog', { name: 'Open external destination?' });
	await expect(destinationDialog).toBeVisible();
	await expect(destinationDialog.getByRole('link', { name: 'Open destination' })).toHaveAttribute(
		'href',
		'https://example.invalid/never-fetch'
	);
	await destinationDialog.getByRole('button', { name: 'Cancel' }).click();
	await expect(destinationDialog).toBeHidden();
	await expect(reviewedDestination).toBeFocused();
	await collapseMarkdown.click();
	await expect(page.getByText(markdownTail)).toBeHidden();
	await expect(markdownSection.getByRole('button', { name: /Show all \d+ words/ })).toBeFocused();

	const plainBlock = page.getByText('notes.txt').locator('..').locator('..');
	// Plain text renders as one whitespace-preserving run, as on the public reader.
	const plainText = plainBlock.locator('p.whitespace-pre-wrap').first();
	await expect(plainText).toContainText('alpha    beta\nline two');
	expect(await plainText.evaluate((node) => getComputedStyle(node).whiteSpace)).toBe('pre-wrap');
	const expandText = plainBlock.getByRole('button', { name: /Show all \d+ words/ });
	await expandText.click();
	await expect(plainText).toContainText('plain125');
	const collapseText = plainBlock.getByRole('button', { name: 'Show snippet' });
	await expect(collapseText).toBeFocused();
	await collapseText.click();
	await expect(plainText).not.toContainText('plain125');
	await expect(plainBlock.getByRole('button', { name: /Show all \d+ words/ })).toBeFocused();
	await expect.poll(() => externalRequests).toEqual([]);
});

test('reviews optional schedule and tier configuration and repairs project scope at None', async ({
	page
}) => {
	await openExport(page);
	await page.getByLabel('Source project').selectOption(projectId);
	const schedule = page.locator('label').filter({ hasText: scheduleName });
	await expect(schedule).toContainText(name);
	await expect(schedule).toContainText('Explicit: Review');
	await expect(schedule).toContainText('Europe/Dublin');
	await expect(schedule).toContainText('Require all prior scheduled issues closed');
	await expect(schedule).toContainText('Scheduled title {{count}}');
	await expect(schedule).toContainText('**Scheduled description**');
	await expect(page.getByText(workflowId, { exact: true })).toHaveCount(0);
	await expect(page.getByText(scheduleId, { exact: true })).toHaveCount(0);

	await page.getByText('Routing preferences (optional)').click();
	const draftTier = page
		.locator('div.rounded-md')
		.filter({ hasText: `${name} › Draft` })
		.last();
	await draftTier.locator('select').selectOption('balanced');
	await draftTier.getByRole('checkbox', { name: 'Project-scoped' }).check();
	await page.getByLabel('Source project').selectOption('');
	await expect(draftTier.getByRole('checkbox', { name: 'Project-scoped' })).not.toBeChecked();
	await page.getByRole('button', { name: 'Apply automation' }).click();
	await expect(page.getByText('Balanced for Draft without a project')).toBeVisible();

	await page.getByLabel('Source project').selectOption(projectId);
	await page.getByRole('checkbox', { name: new RegExp(scheduleName) }).check();
	await draftTier.getByRole('checkbox', { name: 'Project-scoped' }).check();
	await page.getByRole('button', { name: 'Apply automation' }).click();
	const proof = page.locator(`#review-schedule\\:1`);
	await expect(proof).toContainText(scheduleName);
	await expect(proof).toContainText(`workflow:1`);
	await expect(proof).toContainText('Explicit: Review');
	await expect(proof).toContainText('Require every prior scheduled issue to be closed');
	await expect(proof).toContainText('Scheduled title {{count}}');
	await expect(proof).toContainText('Scheduled description');
	await expect(page.getByText('Balanced for Draft in destination project')).toBeVisible();
	await expect(page.getByText(scheduleId)).toHaveCount(0);
});

test('does not restore a stale generated input selection when its ID returns', async ({ page }) => {
	await openExport(page);
	await page.getByLabel('Source project').selectOption(projectId);
	const schedule = page.getByRole('checkbox', { name: new RegExp(scheduleName) });
	await schedule.check();
	await rebuildCandidate(page);
	const destination = declaredInput(page, 'destination_project');
	await destination.click();
	await expect(destination).toHaveAttribute('aria-pressed', 'true');
	await expect(candidateInputs(page).getByText('Selected', { exact: true })).toHaveCount(1);
	// The inventory declares and selects only; passages own every replacement.
	await expect(page.getByLabel('Edit instructions', { exact: true })).toHaveCount(0);
	await expect(page.getByRole('button', { name: 'Use selected variable here' })).toHaveCount(0);
	await expect(candidateInputs(page).locator('select:has(option[value="new"])')).toHaveCount(0);

	await schedule.uncheck();
	await rebuildCandidate(page);
	await expect(destination).toHaveCount(0);
	await expect(candidateInputs(page).getByText('Selected', { exact: true })).toHaveCount(0);

	await schedule.check();
	await rebuildCandidate(page);
	await expect(destination).toHaveAttribute('aria-pressed', 'false');
	await expect(candidateInputs(page).getByText('Selected', { exact: true })).toHaveCount(0);
});

test('retains a generated input selection across an equivalent rebuild', async ({ page }) => {
	await openExport(page);
	await page.getByLabel('Source project').selectOption(projectId);
	await page.getByRole('checkbox', { name: new RegExp(scheduleName) }).check();
	await rebuildCandidate(page);
	const destination = declaredInput(page, 'destination_project');
	await expect(destination).toHaveAttribute('aria-pressed', 'false');
	await expect(candidateInputs(page).getByText('Selected', { exact: true })).toHaveCount(0);

	await destination.click();
	await expect(destination).toHaveAttribute('aria-pressed', 'true');
	await rebuildCandidate(page);
	await expect(destination).toHaveAttribute('aria-pressed', 'true');
	await expect(candidateInputs(page).getByText('Selected', { exact: true })).toHaveCount(1);
});

for (const theme of ['light', 'dark'] as const) {
	for (const viewport of [DESKTOP, PHONE]) {
		test(`keeps declared input selection visible at ${viewport.width}px in ${theme} mode`, async ({
			page
		}, testInfo) => {
			await page.setViewportSize(viewport);
			await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
			await page.goto('/');
			await page.evaluate((savedTheme) => {
				localStorage.setItem('tines:theme', savedTheme);
			}, theme);
			await openExport(page);
			await expect(page.locator('html')).toHaveClass(
				theme === 'dark' ? /\bdark\b/ : /^(?!.*\bdark\b)/
			);
			const longKey = `project_${'n'.repeat(56)}`;
			await page.getByLabel('Key').fill(longKey);
			await page.getByRole('button', { name: 'Add variable' }).click();
			await page.getByLabel('Key').fill('review_label');
			await page.getByLabel('Type').selectOption('label');
			await page.getByRole('button', { name: 'Add variable' }).click();
			const longInput = declaredInput(page, longKey);
			const reviewLabel = declaredInput(page, 'review_label');

			await page.getByRole('button', { name: 'Add variable' }).focus();
			await page.keyboard.press('Tab');
			await expect(longInput).toBeFocused();
			await expect(longInput).toHaveAttribute('aria-pressed', 'false');
			await expect(reviewLabel).toHaveAttribute('aria-pressed', 'true');
			const focusShadow = await longInput.evaluate(
				(element) => getComputedStyle(element).boxShadow
			);
			expect(focusShadow).not.toBe('none');
			await page.keyboard.press('Enter');
			await expect(longInput).toHaveAttribute('aria-pressed', 'true');
			const selectedColors = await longInput.evaluate((element) => {
				const style = getComputedStyle(element);
				return { border: style.borderColor, background: style.backgroundColor };
			});
			const unselectedColors = await reviewLabel.evaluate((element) => {
				const style = getComputedStyle(element);
				return { border: style.borderColor, background: style.backgroundColor };
			});
			expect(selectedColors).not.toEqual(unselectedColors);
			await expect(candidateInputs(page).getByText('Selected', { exact: true })).toHaveCount(1);
			await page.screenshot({
				path: testInfo.outputPath(`package-input-first-${theme}-${viewport.width}.png`),
				fullPage: true
			});

			await longInput.focus();
			await page.keyboard.press('Tab');
			await expect(page.getByRole('button', { name: `Edit variable ${longKey}` })).toBeFocused();
			await page.keyboard.press('Tab');
			await expect(reviewLabel).toBeFocused();
			await page.keyboard.press('Space');
			await expect(reviewLabel).toHaveAttribute('aria-pressed', 'true');
			await expect(longInput).toHaveAttribute('aria-pressed', 'false');
			await page.screenshot({
				path: testInfo.outputPath(`package-input-second-${theme}-${viewport.width}.png`),
				fullPage: true
			});

			await longInput.click();
			await expect(longInput).toHaveAttribute('aria-pressed', 'true');
			// The inventory selection feeds the passage: "Using <key>" beside Make variable, and the
			// chooser preselects that declaration when the form opens.
			const passage = passageSection(page, 'instructions — prompt body');
			await passage
				.getByRole('button', { name: 'Edit instructions — prompt body', exact: true })
				.click();
			const usingBeforeForm = passage.getByTestId('input-replacement');
			await expect(usingBeforeForm).toHaveText(`Using ${longKey}`);
			await passage
				.getByRole('textbox', { name: 'instructions — prompt body' })
				.evaluate((node: HTMLTextAreaElement) => {
					const start = node.value.indexOf('TARGET');
					node.focus();
					node.setSelectionRange(start, start + 'TARGET'.length, 'forward');
					node.dispatchEvent(new Event('select', { bubbles: true }));
				});
			await passage.getByRole('button', { name: 'Make variable' }).click();
			const chooser = passage.locator('select:has(option[value="new"])');
			await expect(chooser).not.toHaveValue('new');
			await expect(chooser.locator('option:checked')).toContainText(` · ${longKey} · `);
			const using = passage.getByTestId('input-replacement');
			await expect(using).toHaveText(`Using ${longKey}`);
			await page.screenshot({
				path: testInfo.outputPath(`package-input-using-${theme}-${viewport.width}.png`),
				fullPage: true
			});
			const geometry = await page.evaluate(() => {
				const longCard = document
					.querySelector<HTMLElement>('section[aria-labelledby="inputs-title"]')!
					.querySelector<HTMLElement>('[aria-pressed="true"]')!;
				const action = document.querySelector<HTMLElement>('[data-testid="input-replacement"]')!;
				return {
					documentOverflow:
						document.documentElement.scrollWidth - document.documentElement.clientWidth,
					cardOverflow: longCard.scrollWidth - longCard.clientWidth,
					actionOverflow: action.scrollWidth - action.clientWidth,
					textOverflow: getComputedStyle(longCard.querySelector('code')!).textOverflow
				};
			});
			expect(geometry.documentOverflow).toBe(0);
			expect(geometry.cardOverflow).toBeLessThanOrEqual(1);
			expect(geometry.actionOverflow).toBeLessThanOrEqual(1);
			expect(geometry.textOverflow).not.toBe('ellipsis');
			await page.keyboard.press('Escape');
			await expect(passage.getByRole('textbox', { name: 'Friendly name' })).toHaveCount(0);
			await expect(
				passage.getByRole('textbox', { name: 'instructions — prompt body' })
			).toBeFocused();
		});
	}
}

test('discards a delayed validation result when candidate review changes', async ({ page }) => {
	await openExport(page);
	await page.getByLabel('Key').fill('race_key');
	await page.getByLabel('Default').fill('before');
	await page.getByRole('button', { name: 'Add variable' }).click();
	await reviewDependencies(page);
	await page.getByRole('button', { name: 'Edit variable race_key' }).click();
	await page.getByLabel('Default').fill('after');
	let releaseValidation!: () => void;
	const held = new Promise<void>((resolve) => (releaseValidation = resolve));
	await page.route('**/api/v1/library/validate', async (route) => {
		const response = await route.fetch();
		await held;
		await route.fulfill({ response });
	});
	let downloads = 0;
	page.on('download', () => (downloads += 1));
	const finished = page.waitForEvent('requestfinished', {
		predicate: (request) => new URL(request.url()).pathname === '/api/v1/library/validate'
	});
	const downloadAttempt = page.getByRole('button', { name: 'Download file' }).click();
	await expect(page.getByRole('button', { name: 'Check file', exact: true })).toBeDisabled();
	await page.getByRole('button', { name: 'Save changes' }).click();
	await expect(
		page.getByText('Review included skills and repositories again.').first()
	).toBeVisible();
	releaseValidation();
	await finished;
	await downloadAttempt;
	await page.evaluate(
		() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
	);
	expect(downloads).toBe(0);
	await expect(
		page.getByText('This copy or its review changed while it was being checked.').first()
	).toBeVisible();
	await page.getByRole('button', { name: 'Edit variable race_key' }).click();
	await expect(page.getByLabel('Default')).toHaveValue('after');
});

test('focuses validation errors and keeps the responsive action clear of navigation', async ({
	page
}) => {
	await page.setViewportSize(PHONE);
	await page.emulateMedia({ reducedMotion: 'reduce' });
	await openExport(page);
	await page.route('**/api/v1/library/validate', async (route) => {
		const payload = route.request().postDataJSON() as { document_json: string };
		const invalid = JSON.parse(payload.document_json) as Omit<WorkflowPackageDocument, 'digest'> & {
			digest?: string;
		};
		invalid.workflows[0].description = 'x'.repeat(10_001);
		delete invalid.digest;
		await route.continue({
			headers: { ...route.request().headers(), 'content-type': 'application/json' },
			postData: JSON.stringify({ document_json: canonicalizeLibraryValue(invalid) })
		});
	});
	await page.getByRole('button', { name: 'Check file', exact: true }).click();
	const errors = page.getByRole('alert');
	await expect(errors).toBeFocused();
	const repair = errors.getByRole('button', { name: `Repair ${name} — description` });
	await repair.click();
	await expect(page.locator('textarea')).toBeFocused();

	for (const width of [PHONE.width, 640, 767, 768]) {
		await page.setViewportSize({ width, height: PHONE.height });
		await page.getByRole('button', { name: 'Download file' }).scrollIntoViewIfNeeded();
		const geometry = await readSettled(() =>
			page.evaluate(() => {
				const action = document
					.querySelector<HTMLElement>('[data-testid="package-actions"]')!
					.getBoundingClientRect();
				const navigation = document
					.querySelector<HTMLElement>('nav[aria-label="Primary"]')!
					.getBoundingClientRect();
				return {
					action: { top: action.top, bottom: action.bottom, height: action.height },
					navigation: { top: navigation.top, height: navigation.height },
					overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth
				};
			})
		);
		expect(geometry.overflow, `document overflow at ${width}px`).toBe(0);
		if (width < 768) {
			expect(geometry.navigation.height).toBeGreaterThan(0);
			expect(geometry.action.bottom, `action/nav clearance at ${width}px`).toBeLessThanOrEqual(
				geometry.navigation.top
			);
			expect(geometry.action.height, `compact action height at ${width}px`).toBeLessThanOrEqual(96);
			await expect(page.getByTestId('package-actions').getByRole('status')).toBeVisible();
			await expect(page.getByText(/required declaration review/)).toBeHidden();
		} else {
			expect(geometry.navigation.height).toBe(0);
			await expect(page.getByTestId('package-actions').getByRole('status')).toBeVisible();
		}
	}
});
