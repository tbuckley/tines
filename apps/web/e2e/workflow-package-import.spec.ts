import { mkdtempSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	canonicalizeLibraryValue,
	type Project,
	type PrepareWorkflowPackageResponse,
	type WorkflowPackageReceipt,
	type ValidateLibraryResponse,
	type WorkflowPackageDocument
} from '@tines/shared';
import { pointerFreeAutomatedPackage } from '../../../packages/shared/src/library/fixtures.js';
import type { Locator, Page } from '@playwright/test';
import { expect, test } from './fixtures';
import {
	signPackagePlan,
	verifyPackagePlan,
	PACKAGE_PLAN_TTL_MS
} from '../src/lib/server/library/token';
import { d1, sqlLiteral } from './d1';
import { BOB } from './constants.mjs';
import { apiClient, body, DESKTOP, gotoHydrated, PHONE, readSettled, signIn } from './helpers';

const LONG_CRON =
	'0 9 1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31 * *';
const IMPLEMENTATION_JARGON =
	/candidate-only|candidate rebuilt|edit candidate text|input declaration|registered tokens|save candidate text|prepared plan|signed plan identity|a different digest is refused/i;

async function expectPlainLanguage(page: Page) {
	const text = (await page.locator('body').innerText()).replace(/\s+/g, ' ').trim();
	expect(text).not.toMatch(IMPLEMENTATION_JARGON);
}

// Check all allocated object/event families, including rows written before a late failure.
function allocatedRows(plan: PrepareWorkflowPackageResponse) {
	const ids = [
		plan.plan_id,
		...Object.values(plan.allocation.records).flatMap((r) => [r.id, r.event_id]),
		...Object.values(plan.allocation.labels).flatMap((r) => [r.id, r.event_id])
	]
		.filter((id): id is string => !!id)
		.map(sqlLiteral)
		.join(',');
	const counts = d1<Record<string, number>>(
		'SELECT ' +
			[
				'library_install',
				'workflow',
				'workflow_state',
				'workflow_transition',
				'context_item',
				'context_item_file',
				'label',
				'scheduled_task',
				'routing_rule',
				'event'
			]
				.map((table) => `(SELECT COUNT(*) FROM ${table} WHERE id IN (${ids})) AS ${table}`)
				.join(', ')
	)[0];
	return Object.entries(counts).filter(([, count]) => count !== 0);
}

async function approve(page: Page) {
	await expect(page.getByRole('heading', { name: 'Workflow graph and gates' })).toBeVisible();
	for (const checkbox of await page
		.getByTestId('package-review')
		.getByRole('checkbox', { name: /I reviewed/ })
		.all())
		await checkbox.check();
	await page.getByRole('checkbox', { name: /I reviewed what will be installed/ }).check();
}

async function expectReceiptLanding(page: Page) {
	const heading = page.getByRole('heading', { name: 'Installed', exact: true });
	const explanation = page.getByText(
		'Created as an independent copy. Selected schedules are paused with no runs or issues created. No project default changed, and installation did not launch work.',
		{ exact: true }
	);
	await expect(heading).toBeFocused();
	await expect
		.poll(() =>
			heading.evaluate((element) => {
				const style = getComputedStyle(element);
				return style.boxShadow !== 'none' || style.outlineStyle !== 'none';
			})
		)
		.toBe(true);
	await expect(explanation).toBeVisible();
	await expect
		.poll(async () => {
			const [headingBox, headerBox] = await Promise.all([
				heading.boundingBox(),
				page.locator('header').boundingBox()
			]);
			return headingBox && headerBox ? headingBox.y - (headerBox.y + headerBox.height) : -1;
		})
		.toBeGreaterThanOrEqual(0);
	await expect
		.poll(async () => {
			const [explanationBox, navigationBox, viewportHeight] = await Promise.all([
				explanation.boundingBox(),
				page.locator('nav[aria-label="Primary"]').boundingBox(),
				page.evaluate(() => window.innerHeight)
			]);
			return explanationBox
				? (navigationBox?.y ?? viewportHeight) - (explanationBox.y + explanationBox.height)
				: -1;
		})
		.toBeGreaterThanOrEqual(0);
}

function definitionValue(article: Locator, term: string) {
	return article
		.locator('dt')
		.filter({ hasText: new RegExp(`^${term}$`) })
		.locator('xpath=following-sibling::dd[1]');
}

async function assertScheduleProof(page: Page, expectedRecurrence: string) {
	const article = page
		.getByTestId('package-review')
		.getByRole('heading', { name: 'Weekly review · installs paused', exact: true })
		.locator('..');
	const recurrence = definitionValue(article, 'Recurrence');
	await expect(recurrence).toHaveText(expectedRecurrence);
	await expect(definitionValue(article, 'Timezone')).toHaveText('America/New_York');
	await expect(article.getByText('installs paused', { exact: false })).toBeVisible();

	const geometry = await recurrence.evaluate((value) => {
		const valueBounds = value.getBoundingClientRect();
		const articleBounds = value.closest('article')!.getBoundingClientRect();
		return {
			valueScrollWidth: value.scrollWidth,
			valueClientWidth: value.clientWidth,
			valueLeft: valueBounds.left,
			valueRight: valueBounds.right,
			articleLeft: articleBounds.left,
			articleRight: articleBounds.right,
			documentWidth: document.documentElement.scrollWidth,
			viewportWidth: window.innerWidth
		};
	});
	expect(geometry.valueScrollWidth).toBeLessThanOrEqual(geometry.valueClientWidth);
	expect(geometry.valueLeft).toBeGreaterThanOrEqual(geometry.articleLeft);
	expect(geometry.valueRight).toBeLessThanOrEqual(geometry.articleRight);
	expect(geometry.valueRight).toBeLessThanOrEqual(geometry.viewportWidth);
	expect(geometry.documentWidth).toBeLessThanOrEqual(geometry.viewportWidth);
}

async function prepareScheduleProof(page: Page, file: string, projectId: string) {
	await gotoHydrated(page, '/workflows/import');
	await page.getByLabel('Workflow package file').setInputFiles(file);
	await page.getByLabel('Filing label').selectOption({ label: filingLabel });
	await page.getByLabel('Destination project').selectOption(projectId);
	await page.getByRole('checkbox', { name: 'Weekly review' }).check();
	await page.getByRole('button', { name: 'Preview installation' }).click();
	await expect(page.getByRole('heading', { name: 'Workflow graph and gates' })).toBeVisible();
}

let suffix: string;
let filingLabel: string;
let packagePath: string;
let missingWorkflowPath: string;
let dependencyFirstPath: string;
let longCronPath: string;
let dependencyFirstDocument: WorkflowPackageDocument;
let candidateDocument: WorkflowPackageDocument;
let mainName: string;
let candidateInputId: string;
let projects: Project[];

test.beforeAll(async ({ apiFor, uniqueName }) => {
	const api = apiFor(BOB);
	suffix = ` ${uniqueName('browser import')}`;
	filingLabel = uniqueName('import-label');
	const candidate = pointerFreeAutomatedPackage();
	(candidate as { digest?: string }).digest = undefined;
	mainName = `Reviewer${suffix}`;
	candidate.workflows[0].name = mainName;
	candidate.inputs[0].default = filingLabel;
	candidateInputId = candidate.inputs[0].id;
	for (const use of candidate.text_uses) {
		use.token = `{{filing_label:${filingLabel}}}`;
	}
	candidate.workflows[0].description = `Review {{filing_label:${filingLabel}}} work`;
	const prompt = candidate.context.find((item) => item.kind === 'prompt')!;
	if (prompt.kind === 'prompt')
		prompt.body = `File work with label {{filing_label:${filingLabel}}}. Preserve {{date}}.`;

	for (const workflow of candidate.workflows)
		await body(
			await api.post('/api/v1/workflows', {
				name: workflow.name,
				description: 'Collision proving independent copy names.',
				initial_state: 'Existing',
				states: [{ name: 'Existing', category: 'active' }],
				transitions: []
			})
		);
	await body(
		await api.post('/api/v1/labels', { name: candidate.inputs[0].default, color: 'blue' })
	);
	projects = await Promise.all(
		['one', 'two'].map(async (part) =>
			body<Project>(
				await api.post('/api/v1/projects', { name: uniqueName(`Import destination ${part}`) })
			)
		)
	);
	const validation = await body<ValidateLibraryResponse>(
		await api.post('/api/v1/library/validate', { document_json: JSON.stringify(candidate) })
	);
	expect(validation.valid).toBe(true);
	const document = validation.document as WorkflowPackageDocument;
	candidateDocument = document;
	packagePath = join(mkdtempSync(join(tmpdir(), 'tines-browser-import-')), 'package.json');
	writeFileSync(packagePath, JSON.stringify(document));
	// Array order is not workflow identity: validate an otherwise unchanged pointer-free file.
	const reordered = {
		...document,
		workflows: [...document.workflows].reverse(),
		digest: undefined
	};
	const reorderedValidation = await body<ValidateLibraryResponse>(
		await api.post('/api/v1/library/validate', { document_json: JSON.stringify(reordered) })
	);
	expect(reorderedValidation.valid).toBe(true);
	dependencyFirstDocument = reorderedValidation.document as WorkflowPackageDocument;
	expect(dependencyFirstDocument.workflows[0].id).toBe(dependencyFirstDocument.main_workflow_id);
	dependencyFirstPath = join(
		mkdtempSync(join(tmpdir(), 'tines-dependency-first-')),
		'package.json'
	);
	writeFileSync(dependencyFirstPath, JSON.stringify(dependencyFirstDocument));
	const longCronCandidate = structuredClone(document);
	(longCronCandidate as { digest?: string }).digest = undefined;
	longCronCandidate.schedules[0].recurrence = { kind: 'cron', cron: LONG_CRON };
	const longCronValidation = await body<ValidateLibraryResponse>(
		await api.post('/api/v1/library/validate', {
			document_json: JSON.stringify(longCronCandidate)
		})
	);
	expect(longCronValidation.valid).toBe(true);
	longCronPath = join(mkdtempSync(join(tmpdir(), 'tines-long-cron-')), 'package.json');
	writeFileSync(longCronPath, JSON.stringify(longCronValidation.document));
	const missingWorkflow = pointerFreeAutomatedPackage();
	(missingWorkflow as { digest?: string }).digest = undefined;
	missingWorkflow.inputs.push({
		id: 'input:destination-workflow',
		key: 'destination_workflow',
		type: 'workflow',
		label: 'Destination workflow',
		description: 'Must provide the required destination states.',
		required: true,
		default: null,
		required_states: ['Ready']
	});
	const missingValidation = await body<ValidateLibraryResponse>(
		await api.post('/api/v1/library/validate', { document_json: JSON.stringify(missingWorkflow) })
	);
	expect(missingValidation.valid).toBe(true);
	missingWorkflowPath = join(
		mkdtempSync(join(tmpdir(), 'tines-missing-workflow-')),
		'package.json'
	);
	writeFileSync(missingWorkflowPath, JSON.stringify(missingValidation.document));
});

test.beforeEach(async ({ context }) => signIn(context, BOB.sessionToken));

test('keeps prepared install actions clear of responsive navigation', async ({ page }) => {
	await page.setViewportSize({ width: 640, height: 844 });
	await prepareScheduleProof(page, packagePath, projects[0].id);
	const actions = page.getByTestId('install-actions');
	const finalReview = page
		.getByTestId('package-review')
		.getByRole('checkbox', { name: /I reviewed/ })
		.last();
	await expect(actions).toBeVisible();
	await expect(
		page.getByText('Review every included skill and repository before installing.')
	).toBeVisible();

	for (const width of [640, 767, 768]) {
		await page.setViewportSize({ width, height: 844 });
		await finalReview.scrollIntoViewIfNeeded();
		const geometry = await readSettled(() =>
			page.evaluate(() => {
				const actions = document
					.querySelector<HTMLElement>('[data-testid="install-actions"]')!
					.getBoundingClientRect();
				const navigation = document
					.querySelector<HTMLElement>('nav[aria-label="Primary"]')!
					.getBoundingClientRect();
				const finalReview = [
					...document.querySelectorAll<HTMLElement>(
						'[data-testid="package-review"] input[type="checkbox"]'
					)
				]
					.at(-1)!
					.getBoundingClientRect();
				return {
					actions: { top: actions.top, bottom: actions.bottom },
					navigation: { top: navigation.top, height: navigation.height },
					finalReviewBottom: finalReview.bottom,
					overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
					viewportHeight: window.innerHeight
				};
			})
		);
		expect(geometry.overflow, `document overflow at ${width}px`).toBe(0);
		expect(
			geometry.finalReviewBottom,
			`final review reachability at ${width}px`
		).toBeLessThanOrEqual(geometry.actions.top);
		if (width < 768) {
			expect(geometry.navigation.height).toBeGreaterThan(0);
			expect(geometry.actions.bottom, `install/nav clearance at ${width}px`).toBeLessThanOrEqual(
				geometry.navigation.top
			);
		} else {
			expect(geometry.navigation.height).toBe(0);
			expect(geometry.actions.bottom).toBe(geometry.viewportHeight);
		}
		await expect(
			page.getByRole('checkbox', { name: /I reviewed what will be installed/ })
		).toBeEnabled();
		await expect(page.getByRole('button', { name: 'Install workflow' })).toBeVisible();
	}
});

test('reviews, confirms and installs an independent project-free package through the real backend', async ({
	page,
	request
}) => {
	await page.setViewportSize(DESKTOP);
	await gotoHydrated(page, '/workflows');
	await expect(page.getByRole('link', { name: 'Install package' })).toHaveAttribute(
		'href',
		'/workflows/import'
	);
	await gotoHydrated(page, '/workflows/import');
	await expect(
		page.getByText(
			'Choose a workflow package file to check what it includes. Nothing is installed until you review and confirm.'
		)
	).toBeVisible();
	await expectPlainLanguage(page);
	await page.getByLabel('Workflow package file').setInputFiles(packagePath);
	await expect(page.getByRole('heading', { name: 'Destination values' })).toBeVisible();
	for (const schedule of await page
		.getByRole('group', { name: 'Optional paused schedules' })
		.getByRole('checkbox')
		.all())
		await expect(schedule).not.toBeChecked();
	await expect(page.getByLabel('Destination project')).toHaveValue('');

	await page.getByRole('button', { name: 'Preview installation' }).click();
	await expect(page.getByRole('heading', { name: 'Workflow graph and gates' })).toBeVisible();
	await expect(
		page.getByRole('heading', { name: `${mainName} (imported)`, exact: true })
	).toBeVisible();
	const review = page.getByTestId('package-review');
	const mainGraph = review
		.getByRole('heading', { name: `${mainName} (imported)`, exact: true })
		.locator('xpath=ancestor::article')
		.getByRole('img', { name: 'Workflow graph' });
	await expect(mainGraph.getByText('Review', { exact: true })).toBeVisible();
	await expect(mainGraph.getByText('Handoff', { exact: true })).toBeVisible();
	const fitted = await mainGraph.evaluate((svg) => ({
		width: svg.getBoundingClientRect().width,
		containerWidth: svg.parentElement!.clientWidth
	}));
	expect(fitted.width).toBeLessThanOrEqual(fitted.containerWidth + 1);
	await expect(page.getByText('Variable values', { exact: true })).toBeVisible();
	await expect(page.getByText('Original', { exact: true }).first()).toBeVisible();
	await expect(page.getByText('Installed value', { exact: true }).first()).toBeVisible();
	await expect(page.getByRole('button', { name: 'Edit candidate text' })).toHaveCount(0);
	const exactUse = page.getByRole('button', { name: /Show variable value/ }).first();
	await exactUse.click();
	await expect(page.getByRole('button', { name: 'Back to passage' })).toBeVisible();
	await expect(page.locator(`[id="value-${candidateInputId}"]`)).toBeFocused();
	await page.keyboard.press('Escape');
	await expect(exactUse).toBeFocused();

	const installRequests: string[] = [];
	page.on('request', (request) => {
		if (request.method() === 'POST' && request.url().endsWith('/api/v1/library/install'))
			installRequests.push(request.url());
	});
	const confirm = page.getByRole('checkbox', { name: /I reviewed what will be installed/ });
	await confirm.check();
	await expect(page.getByRole('button', { name: 'Install workflow' })).toBeDisabled();
	await page.getByRole('button', { name: 'Install workflow' }).dispatchEvent('click');
	await page.waitForTimeout(100);
	expect(installRequests).toEqual([]);
	for (const checkbox of await page
		.getByTestId('package-review')
		.getByRole('checkbox', { name: /I reviewed/ })
		.all())
		await checkbox.check();
	await page.getByLabel(`Main · ${mainName}`).fill(`${mainName} reviewed`);
	await expect(confirm).toHaveCount(0);
	await page.getByRole('button', { name: 'Preview installation' }).click();
	await expect(
		page.getByRole('checkbox', { name: /I reviewed what will be installed/ })
	).not.toBeChecked();
	for (const checkbox of await page
		.getByTestId('package-review')
		.getByRole('checkbox', { name: /I reviewed/ })
		.all())
		await expect(checkbox).not.toBeChecked();
	await expect(page.getByRole('button', { name: 'Install workflow' })).toBeDisabled();
	for (const checkbox of await page
		.getByTestId('package-review')
		.getByRole('checkbox', { name: /I reviewed/ })
		.all())
		await checkbox.check();

	await page.setViewportSize(PHONE);
	const width = await page.evaluate(() => document.documentElement.scrollWidth);
	expect(width).toBeLessThanOrEqual(PHONE.width);
	const freshConfirm = page.getByRole('checkbox', { name: /I reviewed what will be installed/ });
	await freshConfirm.focus();
	await page.keyboard.press('Space');
	await expect(freshConfirm).toBeChecked();
	const installResponse = page.waitForResponse(
		(response) =>
			response.request().method() === 'POST' &&
			response.url().endsWith('/api/v1/library/install') &&
			response.ok()
	);
	await page.getByRole('button', { name: 'Install workflow' }).click();
	const receipt = (await (await installResponse).json()) as WorkflowPackageReceipt;
	await expectReceiptLanding(page);
	const firstObjectLink = page.getByRole('link', { name: 'Open workflow' }).first();
	await expect(firstObjectLink).toHaveAttribute('href', /^\/workflows\//);
	await expect(page.locator('[data-package-receipt] code')).toBeHidden();
	await page.keyboard.press('Tab');
	await expect(page.locator('[data-package-receipt] summary')).toBeFocused();
	await page.keyboard.press('Tab');
	await expect(firstObjectLink).toBeFocused();
	expect(installRequests).toHaveLength(1);

	const mainWorkflow = receipt.objects.find(
		(object) => object.kind === 'workflow' && object.relationship === 'main'
	)!;
	const mainDocument = candidateDocument.workflows.find(
		(workflow) => workflow.id === candidateDocument.main_workflow_id
	)!;
	const localState = mainDocument.states[0];
	const installedState = receipt.objects.find(
		(object) => object.kind === 'state' && object.local_id === localState.id
	)!;
	const expectedStateHref = `/workflows/${mainWorkflow.id}?state=${installedState.id}#state-${installedState.id}`;
	const stateRow = page
		.locator('[data-package-receipt] li')
		.filter({ hasText: `state · ${installedState.name}` });
	const stateLink = stateRow.getByRole('link', { name: 'Open state' });
	await expect(stateLink).toHaveAttribute('href', expectedStateHref);
	await stateLink.click();
	await expect(page).toHaveURL(expectedStateHref);
	const target = page.locator(`#state-${installedState.id}`);
	await expect(target).toHaveCount(1);
	await expect(target.locator(':scope > button')).toHaveAttribute('aria-expanded', 'true');
	await expect(target).toBeInViewport();

	await page.goto(`/workflows/${mainWorkflow.id}#state-${installedState.id}`);
	await expect(page.locator(`#state-${installedState.id}`)).toHaveCount(1);
	await expect(page.locator(`#state-${installedState.id}`)).toBeInViewport();

	const api = apiClient(request, BOB.apiKey);
	for (const project of projects) {
		const schedules = await body<{ items: unknown[] }>(
			await api.get(`/api/v1/projects/${project.id}/schedules`)
		);
		expect(schedules.items).toEqual([]);
	}
});

test('identifies the main workflow by ID in a reordered pointer-free file before confirmation', async ({
	page
}) => {
	const main = dependencyFirstDocument.workflows.find(
		(workflow) => workflow.id === dependencyFirstDocument.main_workflow_id
	)!;
	for (const viewport of [DESKTOP, PHONE]) {
		await page.setViewportSize(viewport);
		await gotoHydrated(page, '/workflows/import');
		await page.getByLabel('Workflow package file').setInputFiles(dependencyFirstPath);
		const mainInput = page.getByRole('textbox', { name: `Main · ${main.name}`, exact: true });
		await expect(mainInput).toHaveAttribute('id', `name-${main.id}`);
		const renamedMain = `${main.name} main ${viewport.width}`;
		await mainInput.fill(renamedMain);
		const preparing = page.waitForResponse('**/api/v1/library/prepare');
		await page.getByRole('button', { name: 'Preview installation' }).click();
		const response = await preparing;
		expect(response.ok()).toBe(true);
		// The browser must preserve the validated source bytes/digest and send names keyed by ID.
		const request = response.request().postDataJSON();
		expect(JSON.parse(request.document_json)).toEqual(dependencyFirstDocument);
		expect(request.choices.workflow_names).toMatchObject({ [main.id]: renamedMain });
		const review = page.getByTestId('package-review');
		const mainCard = review.locator(`article[id="review-${main.id}"]`);
		await expect(mainCard.getByRole('heading', { name: renamedMain, exact: true })).toBeVisible();
		await expect(mainCard.getByText('Main workflow', { exact: true })).toBeVisible();
		await expect(
			mainCard.getByText('Required inheritance dependency', { exact: true })
		).toHaveCount(0);
		await expect(
			page.getByRole('checkbox', { name: /I reviewed what will be installed/ })
		).not.toBeChecked();
		await expect(page.getByRole('button', { name: 'Install workflow' })).toBeDisabled();
		expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
			viewport.width
		);
	}
});

test('retries the exact plan after reload and real 404, then recovers a lost committed response', async ({
	page
}) => {
	await page.setViewportSize(PHONE);
	const requests: unknown[] = [];
	let committed: WorkflowPackageReceipt | undefined;
	let prepares = 0;
	page.on('request', (request) => {
		if (request.url().endsWith('/api/v1/library/prepare')) prepares++;
	});
	await gotoHydrated(page, '/workflows/import');
	await page.getByLabel('Workflow package file').setInputFiles(packagePath);
	await page.getByRole('button', { name: 'Preview installation' }).click();
	await expect(page.getByRole('heading', { name: 'Workflow graph and gates' })).toBeVisible();
	for (const checkbox of await page
		.getByTestId('package-review')
		.getByRole('checkbox', { name: /I reviewed/ })
		.all())
		await checkbox.check();
	await page.getByRole('checkbox', { name: /I reviewed what will be installed/ }).check();
	await page.route('**/api/v1/library/install', async (route) => {
		requests.push(route.request().postDataJSON());
		if (requests.length > 1) {
			const response = await route.fetch();
			expect(response.ok()).toBe(true);
			committed = await response.json();
			await route.abort('connectionreset');
			return;
		}
		return route.fulfill({
			status: 503,
			contentType: 'application/json',
			body: JSON.stringify({
				error: {
					code: 'install_outcome_unknown',
					message: 'The result could not be determined',
					details: null
				}
			})
		});
	});
	await page.getByRole('button', { name: 'Install workflow' }).click();
	await expect(page.getByRole('heading', { name: 'Installation status is unknown' })).toBeVisible();
	await expect(page.getByRole('alert')).toContainText(
		'We could not confirm whether installation finished. Choose Check result before retrying.'
	);
	await expect(page.getByRole('button', { name: 'Check result' })).toBeVisible();
	await expect(page.getByRole('button', { name: 'Retry installation' })).toBeVisible();
	const saved = await page.evaluate(() =>
		JSON.parse(sessionStorage.getItem('tines:workflow-package-install-recovery:v1') ?? 'null')
	);
	expect(saved).toMatchObject({ planId: expect.any(String), planToken: expect.any(String) });
	expect(JSON.stringify(saved)).not.toContain(mainName);
	const errorDetails = page.getByRole('alert').locator('details');
	await expect(errorDetails).not.toHaveAttribute('open', '');
	await expect(page.getByText('install_outcome_unknown', { exact: true })).toBeHidden();
	await expectPlainLanguage(page);
	await page.reload({ waitUntil: 'networkidle' });
	await expect(page.getByRole('heading', { name: 'Installation status is unknown' })).toBeVisible();
	await expect(page.getByRole('button', { name: 'Check result' })).toBeVisible();
	const recoverySection = page
		.getByRole('heading', { name: 'Installation status is unknown' })
		.locator('..');
	const recoveryDetails = recoverySection.locator('details');
	await expect(recoveryDetails).not.toHaveAttribute('open', '');
	await expect(page.getByText(saved.planId, { exact: true })).toBeHidden();
	await expect(page.getByText(saved.planDigest, { exact: true })).toBeHidden();
	await expect(page.getByText(saved.documentDigest, { exact: true })).toBeHidden();
	expect(await page.locator('body').textContent()).not.toContain(saved.planToken);
	await expectPlainLanguage(page);
	await recoveryDetails.getByText('Technical details', { exact: true }).click();
	await expect(page.getByText(saved.planId, { exact: true })).toBeVisible();
	await expect(page.getByText(saved.planDigest, { exact: true })).toBeVisible();
	await expect(page.getByText(saved.documentDigest, { exact: true })).toBeVisible();
	expect(await page.locator('body').textContent()).not.toContain(saved.planToken);
	await recoveryDetails.getByText('Technical details', { exact: true }).click();
	await page.getByRole('button', { name: 'Check result' }).click();
	await expect(page.getByRole('alert')).toContainText(
		'No result is available yet. Installation may still be running. Choose Check result again, or retry the same installation.'
	);
	await expectPlainLanguage(page);
	await expect(page.getByRole('button', { name: 'Preview installation' })).toHaveCount(0);
	await page.getByLabel('Workflow package file').setInputFiles(packagePath);
	await page.getByRole('button', { name: 'Retry installation' }).click();
	await expect(page.getByRole('heading', { name: 'Installation status is unknown' })).toBeVisible();
	expect(requests).toHaveLength(2);
	expect(requests[1]).toEqual(requests[0]);
	expect(committed?.id).toBe(saved.planId);
	await page.reload({ waitUntil: 'networkidle' });
	await page.getByRole('button', { name: 'Check result' }).click();
	await expectReceiptLanding(page);
	expect(prepares).toBe(1);
	expect(d1(`SELECT id FROM library_install WHERE id=${sqlLiteral(saved.planId)}`)).toEqual([
		{ id: saved.planId }
	]);
	expect(
		await page.evaluate(() => sessionStorage.getItem('tines:workflow-package-install-recovery:v1'))
	).toBeNull();
});

test('preserves a committed recovery across wrong, invalid and legacy files', async ({ page }) => {
	const requests: unknown[] = [];
	let committed: WorkflowPackageReceipt;
	let prepares = 0;
	page.on('request', (request) => {
		if (request.url().endsWith('/api/v1/library/prepare')) prepares++;
	});
	await gotoHydrated(page, '/workflows/import');
	await page.getByLabel('Workflow package file').setInputFiles(packagePath);
	await page.getByRole('button', { name: 'Preview installation' }).click();
	await approve(page);
	await page.route('**/api/v1/library/install', async (route) => {
		requests.push(route.request().postDataJSON());
		const response = await route.fetch();
		expect(response.ok()).toBe(true);
		committed = await response.json();
		await route.abort('connectionreset');
	});
	await page.getByRole('button', { name: 'Install workflow' }).click();
	await expect(page.getByRole('heading', { name: 'Installation status is unknown' })).toBeVisible();
	const savedRecovery = () =>
		page.evaluate(() => sessionStorage.getItem('tines:workflow-package-install-recovery:v1'));
	const saved = await savedRecovery();
	expect(JSON.parse(saved!).planId).toBe(committed!.id);
	await page.reload({ waitUntil: 'networkidle' });
	const retry = page.getByRole('button', { name: 'Retry installation' });
	await expect(retry).toBeDisabled();
	const rejectedFiles = [
		{
			file: missingWorkflowPath,
			message:
				'This file does not match the installation awaiting recovery. Choose the original workflow package file.'
		},
		{
			file: { name: 'broken.json', mimeType: 'application/json', buffer: Buffer.from('{') },
			message:
				'Choose the original workflow package file to retry this installation, or choose Check result.'
		},
		{
			file: {
				name: 'invalid.json',
				mimeType: 'application/json',
				buffer: Buffer.from(JSON.stringify({ version: 3, profile: 'workflow' }))
			},
			message:
				'Choose the original workflow package file to retry this installation, or choose Check result.'
		},
		{
			file: {
				name: 'legacy.json',
				mimeType: 'application/json',
				buffer: Buffer.from(JSON.stringify({ version: 2 }))
			},
			message:
				'Choose the original workflow package file to retry this installation, or choose Check result.'
		}
	];
	for (const [index, rejected] of rejectedFiles.entries()) {
		await page.setViewportSize(index % 2 ? PHONE : DESKTOP);
		// Begin with an accepted document: each rejected selection must revoke it.
		await page.getByLabel('Workflow package file').setInputFiles(packagePath);
		await expect(retry).toBeEnabled();
		await page.getByLabel('Workflow package file').setInputFiles(rejected.file);
		await expect(page.getByRole('alert')).toContainText(rejected.message);
		await expect(
			page.getByRole('heading', { name: 'Installation status is unknown' })
		).toBeVisible();
		await expect(retry).toBeDisabled();
		await expect(page.getByRole('button', { name: 'Check result' })).toBeVisible();
		await expect(page.getByRole('button', { name: 'Preview installation' })).toHaveCount(0);
		// Dispatch bypasses native disabled handling and pins the handler's fence.
		await retry.dispatchEvent('click');
		await page.evaluate(
			() =>
				new Promise<void>((resolve) =>
					requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
				)
		);
		expect(requests).toHaveLength(1);
		expect(await savedRecovery()).toBe(saved);
		await expectPlainLanguage(page);
	}
	// Even a rejected retry of the matching file cannot establish the original outcome.
	await page.getByLabel('Workflow package file').setInputFiles(packagePath);
	await expect(retry).toBeEnabled();
	await page.unroute('**/api/v1/library/install');
	await page.route('**/api/v1/library/install', async (route) => {
		requests.push(route.request().postDataJSON());
		await route.fulfill({
			status: 409,
			contentType: 'application/json',
			body: JSON.stringify({ error: { code: 'package_changed', message: 'Retry rejected' } })
		});
	});
	await retry.click();
	await expect(page.getByRole('alert')).toContainText(
		'The retry did not finish. The original installation result is still unknown. Choose Check result before taking further action.'
	);
	await expectPlainLanguage(page);
	expect(requests).toHaveLength(2);
	expect(requests[1]).toEqual(requests[0]);
	expect(await savedRecovery()).toBe(saved);
	await page.reload({ waitUntil: 'networkidle' });
	await page.getByRole('button', { name: 'Check result' }).click();
	await expect(page.getByRole('heading', { name: 'Installed', exact: true })).toBeFocused();
	expect(prepares).toBe(1);
	expect(await savedRecovery()).toBeNull();
	expect(d1(`SELECT id FROM library_install WHERE id=${sqlLiteral(committed!.id)}`)).toEqual([
		{ id: committed!.id }
	]);
});

test('turns a confirmation mismatch into a fresh-preview instruction without leaking server copy', async ({
	page
}) => {
	await gotoHydrated(page, '/workflows/import');
	await page.getByLabel('Workflow package file').setInputFiles(packagePath);
	const prepared = page.waitForResponse((response) =>
		response.url().endsWith('/api/v1/library/prepare')
	);
	await page.getByRole('button', { name: 'Preview installation' }).click();
	const plan = (await (await prepared).json()) as PrepareWorkflowPackageResponse;
	await approve(page);
	await page.route('**/api/v1/library/install', (route) =>
		route.fulfill({
			status: 409,
			contentType: 'application/json',
			body: JSON.stringify({
				error: {
					code: 'confirmation_mismatch',
					message: 'Confirm the exact prepared plan digest',
					details: null
				}
			})
		})
	);
	await page.getByRole('button', { name: 'Install workflow' }).click();
	const alert = page.getByRole('alert');
	await expect(alert).toContainText(
		'The file or confirmation no longer matches the preview. Nothing was created by this rejected attempt. Choose Preview installation and review it again.'
	);
	await expect(alert).not.toContainText('prepared plan digest');
	await expect(alert.locator('details')).not.toHaveAttribute('open', '');
	await expect(page.getByText('confirmation_mismatch', { exact: true })).toBeHidden();
	await expect(page.getByRole('button', { name: 'Preview installation' })).toBeVisible();
	await expectPlainLanguage(page);
	expect(allocatedRows(plan)).toEqual([]);
});

test('rejects an expired signed plan and requires fresh preparation and confirmation', async ({
	page
}) => {
	const signingKey = 'e2e-only-secret-encryption-key';
	let expiredPlan: PrepareWorkflowPackageResponse;
	// Backdate only this real server preparation with the local test signing key.
	// The browser still submits it to the real worker's signature/expiry checks.
	await page.route('**/api/v1/library/prepare', async (route) => {
		const response = await route.fetch();
		expect(response.ok()).toBe(true);
		expiredPlan = await response.json();
		const payload = await verifyPackagePlan(expiredPlan.plan_token, signingKey);
		const { plan_digest, ...unsigned } = payload;
		const digest = (plan: typeof unsigned) =>
			`sha256:${createHash('sha256')
				.update(canonicalizeLibraryValue({ plan, resolved: expiredPlan.resolved }))
				.digest('hex')}`;
		// Verify the complete digest input before backdating it. Expiry must be the
		// only invalid property, not an accidentally stale digest or bad signature.
		expect(digest(unsigned)).toBe(plan_digest);
		const expiresAt = Date.now() - 1000;
		const backdated = {
			...unsigned,
			issued_at: expiresAt - PACKAGE_PLAN_TTL_MS,
			expires_at: expiresAt
		};
		expiredPlan.plan_digest = digest(backdated);
		expiredPlan.plan_token = await signPackagePlan(
			{ ...backdated, plan_digest: expiredPlan.plan_digest },
			signingKey
		);
		expiredPlan.issued_at = backdated.issued_at;
		expiredPlan.expires_at = expiresAt;
		await route.fulfill({ response, json: expiredPlan });
	});
	await gotoHydrated(page, '/workflows/import');
	await page.getByLabel('Workflow package file').setInputFiles(packagePath);
	await page.getByLabel(`Main · ${mainName}`).fill(`${mainName} expiry`);
	await page.getByRole('button', { name: 'Preview installation' }).click();
	await approve(page);
	const rejected = page.waitForResponse((r) => r.url().endsWith('/api/v1/library/install'));
	await page.getByRole('button', { name: 'Install workflow' }).click();
	expect((await rejected).status()).toBe(409);
	await expect(page.getByRole('alert')).toContainText(
		'The preview expired or the destination changed. Nothing was created by this rejected attempt. Choose Preview installation and review it again.'
	);
	await expectPlainLanguage(page);
	expect(allocatedRows(expiredPlan!)).toEqual([]);
	await expect(page.getByLabel(`Main · ${mainName}`)).toHaveValue(`${mainName} expiry`);
	await expect(
		page.getByRole('checkbox', { name: /I reviewed what will be installed/ })
	).toHaveCount(0);
	await page.unroute('**/api/v1/library/prepare');
	const prepared = page.waitForResponse((r) => r.url().endsWith('/api/v1/library/prepare'));
	await page.getByRole('button', { name: 'Preview installation' }).click();
	const fresh = (await (await prepared).json()) as PrepareWorkflowPackageResponse;
	expect(fresh.plan_id).not.toBe(expiredPlan!.plan_id);
	expect(fresh.plan_digest).not.toBe(expiredPlan!.plan_digest);
	await expect(
		page.getByRole('checkbox', { name: /I reviewed what will be installed/ })
	).not.toBeChecked();
	await expect(page.getByRole('button', { name: 'Install workflow' })).toBeDisabled();
	await approve(page);
	await page.getByRole('button', { name: 'Install workflow' }).click();
	await expect(page.getByRole('heading', { name: 'Installed', exact: true })).toBeFocused();
});

test('a late native D1 failure rolls back every allocated row and permits the same confirmed plan retry', async ({
	page
}) => {
	test.setTimeout(60_000);
	await gotoHydrated(page, '/workflows/import');
	await page.getByLabel('Workflow package file').setInputFiles(packagePath);
	const prepared = page.waitForResponse((r) => r.url().endsWith('/api/v1/library/prepare'));
	await page.getByRole('button', { name: 'Preview installation' }).click();
	const plan = (await (await prepared).json()) as PrepareWorkflowPackageResponse;
	await approve(page);
	const file = plan.document.context.flatMap((item) =>
		item.kind === 'skill' ? item.files : []
	)[0];
	const fileId = plan.allocation.records[file.id].id;
	const attempts: unknown[] = [];
	page.on('request', (request) => {
		if (request.url().endsWith('/api/v1/library/install')) attempts.push(request.postDataJSON());
	});
	d1(
		`CREATE TRIGGER browser_install_failure BEFORE INSERT ON context_item_file WHEN NEW.id=${sqlLiteral(fileId)} BEGIN SELECT RAISE(ABORT, 'browser install injection'); END`
	);
	try {
		const failed = page.waitForResponse((r) => r.url().endsWith('/api/v1/library/install'));
		await page.getByRole('button', { name: 'Install workflow' }).click();
		expect((await failed).status()).toBe(500);
		await expect(page.getByRole('alert')).toBeFocused();
		await expect(page.getByRole('alert')).toContainText(
			'Installation did not finish. Your reviewed choices are still available. Choose Install workflow to retry.'
		);
		await expect(page.getByRole('heading', { name: 'Installation status is unknown' })).toHaveCount(
			0
		);
		await expect(page.getByRole('button', { name: 'Install workflow' })).toBeEnabled();
		expect(allocatedRows(plan)).toEqual([]);
	} finally {
		d1('DROP TRIGGER IF EXISTS browser_install_failure');
	}
	await page.getByRole('button', { name: 'Install workflow' }).click();
	await expect(page.getByRole('heading', { name: 'Installed', exact: true })).toBeFocused();
	expect(attempts).toHaveLength(2);
	expect(attempts[1]).toEqual(attempts[0]);
	expect(d1(`SELECT id FROM library_install WHERE id=${sqlLiteral(plan.plan_id)}`)).toEqual([
		{ id: plan.plan_id }
	]);
});

for (const theme of ['light', 'dark'] as const) {
	for (const viewport of [DESKTOP, PHONE]) {
		test(`keeps weekly and long-cron schedule proofs readable at ${viewport.width}px in ${theme} mode`, async ({
			page
		}, testInfo) => {
			await page.setViewportSize(viewport);
			await page.addInitScript((savedTheme) => {
				localStorage.setItem('tines:theme', savedTheme);
			}, theme);

			await prepareScheduleProof(page, packagePath, projects[0].id);
			await expect(page.locator('html')).toHaveClass(
				theme === 'dark' ? /\bdark\b/ : /^(?!.*\bdark\b)/
			);
			await assertScheduleProof(page, 'Every Monday at 09:00');
			await page.screenshot({
				path: testInfo.outputPath(`schedule-weekly-${theme}-${viewport.width}.png`),
				fullPage: true
			});

			await prepareScheduleProof(page, longCronPath, projects[0].id);
			await assertScheduleProof(page, `Cron “${LONG_CRON}”`);
			await page.screenshot({
				path: testInfo.outputPath(`schedule-cron-${theme}-${viewport.width}.png`),
				fullPage: true
			});
		});
	}
}

test('installs selected schedules paused into two independent destination projects', async ({
	page,
	request
}) => {
	const api = apiClient(request, BOB.apiKey);
	for (const [projectIndex, project] of projects.entries()) {
		const beforeIssues = await body<{ items: unknown[] }>(
			await api.get(`/api/v1/issues?project=${project.id}`)
		);
		const beforeSchedules = await body<{ items: unknown[] }>(
			await api.get(`/api/v1/projects/${project.id}/schedules`)
		);
		expect(beforeIssues.items).toEqual([]);
		expect(beforeSchedules.items).toEqual([]);
		expect(project.default_workflow_id).toBeNull();

		await page.setViewportSize(projectIndex === 0 ? PHONE : DESKTOP);
		await gotoHydrated(page, '/workflows/import');
		await page.getByLabel('Workflow package file').setInputFiles(packagePath);
		await page.getByLabel('Filing label').selectOption({ label: filingLabel });
		await page.getByLabel('Destination project').selectOption(project.id);
		await page.getByRole('checkbox', { name: 'Weekly review' }).check();
		await page.getByRole('button', { name: 'Preview installation' }).click();
		await expect(page.getByRole('heading', { name: 'Workflow graph and gates' })).toBeVisible();
		await assertScheduleProof(page, 'Every Monday at 09:00');
		for (const checkbox of await page
			.getByTestId('package-review')
			.getByRole('checkbox', { name: /I reviewed/ })
			.all())
			await checkbox.check();
		await page.getByRole('checkbox', { name: /I reviewed what will be installed/ }).check();
		await page.getByRole('button', { name: 'Install workflow' }).click();
		await expectReceiptLanding(page);
		await expect(page.getByText('paused', { exact: false })).toBeVisible();

		const afterIssues = await body<{ items: unknown[] }>(
			await api.get(`/api/v1/issues?project=${project.id}`)
		);
		const afterSchedules = await body<{
			items: Array<{ enabled: boolean; run_count: number; last_run_at: number | null }>;
		}>(await api.get(`/api/v1/projects/${project.id}/schedules`));
		const afterProject = await body<Project>(await api.get(`/api/v1/projects/${project.id}`));
		expect(afterIssues.items).toEqual([]);
		expect(afterSchedules.items).toHaveLength(1);
		expect(afterSchedules.items[0]).toMatchObject({
			enabled: false,
			run_count: 0,
			last_run_at: null
		});
		expect(afterProject.default_workflow_id).toBeNull();
	}
});

test('links field and capability failures to their normal destination pages', async ({ page }) => {
	await gotoHydrated(page, '/workflows/import');
	await page.getByLabel('Workflow package file').setInputFiles(missingWorkflowPath);
	await page.getByLabel('Filing label').selectOption({ label: 'Create “qa”' });
	await page.getByRole('button', { name: 'Preview installation' }).click();
	await expect(page.getByRole('link', { name: 'Create a destination workflow' })).toHaveAttribute(
		'href',
		'/workflows/new'
	);

	await page.getByLabel('Workflow package file').setInputFiles(packagePath);
	const tier = page
		.getByRole('group', { name: 'Optional destination tier preferences' })
		.locator('select')
		.first();
	await tier.selectOption({ index: 1 });
	await page.route('**/api/v1/library/prepare', async (route) =>
		route.fulfill({
			status: 422,
			contentType: 'application/json',
			body: JSON.stringify({
				error: {
					code: 'routing_unavailable',
					message: 'No active supported destination runner supplies this tier',
					details: { record_id: 'routing:1' }
				}
			})
		})
	);
	await page.getByRole('button', { name: 'Preview installation' }).click();
	await expect(page.getByRole('link', { name: 'Configure destination runners' })).toHaveAttribute(
		'href',
		'/agents#routing'
	);
});

test('links the settings entry point and routes whole-library files without preparing them', async ({
	page
}) => {
	await gotoHydrated(page, '/settings/export-import');
	await expect(page.getByRole('link', { name: 'Install workflow package' })).toHaveAttribute(
		'href',
		'/workflows/import'
	);
	await gotoHydrated(page, '/workflows/import');
	const legacy = join(mkdtempSync(join(tmpdir(), 'tines-library-import-')), 'library.json');
	writeFileSync(
		legacy,
		JSON.stringify({
			format: 'tines.library',
			version: 2,
			projects: [],
			workflows: [],
			context: []
		})
	);
	await page.getByLabel('Workflow package file').setInputFiles(legacy);
	await expect(page.getByRole('heading', { name: 'Whole-library import' })).toBeVisible();
	await expect(page.getByRole('link', { name: 'Open whole-library importer' })).toHaveAttribute(
		'href',
		'/settings/export-import'
	);
});
