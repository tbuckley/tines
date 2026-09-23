import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
	CreateProjectResponse,
	IssueDetail,
	LaunchPromptResponse,
	StarterSummary
} from '@tines/shared';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { ALICE, BASE_URL } from './constants.mjs';
import { apiClient, body, clickUntil, gotoHydrated, runId, signIn } from './helpers';

/**
 * The New-project dialog's "Start from" chooser (Tines/249).
 *
 * Sorts after `artifacts-panel.spec.ts`, whose relative-age assertions are
 * sensitive to what runs before it — do not rename this file to something
 * that sorts earlier.
 *
 * Assertions read the starter *summaries* from the API rather than hardcoding
 * prose, because the starter content is another issue's to change (Tines/250):
 * what is pinned here is the dialog's behaviour, not the words in it.
 *
 * Nothing here asserts on how many workflows exist. Workflows are user-scoped
 * and a starter reuses a structurally identical one, so on a reused server the
 * second run legitimately takes the reuse branch.
 */

let starters: StarterSummary[];
const CLI_DIR = fileURLToPath(new URL('../../../packages/cli', import.meta.url));
const TSX = join(CLI_DIR, 'node_modules', '.bin', 'tsx');
const CLI_ENTRY = join(CLI_DIR, 'src', 'index.ts');
const byId = (id: string): StarterSummary => {
	const found = starters.find((s) => s.id === id);
	if (!found) throw new Error(`starter ${id} missing from the menu`);
	return found;
};

test.beforeAll(async ({ apiFor }) => {
	const api = apiFor(ALICE);
	const res = await api.get('/api/v1/projects/starters');
	expect(res.status(), 'the starter menu must load').toBe(200);
	starters = (await body<{ items: StarterSummary[] }>(res)).items;
});

test.use({ signedIn: ALICE });

test('Code repository seeds the first issue launch context and gated review workflow', async ({
	page,
	request,
	uniqueName
}) => {
	const api = apiClient(request, ALICE.apiKey);
	const projectName = uniqueName('starter-code-api');
	const repoName = uniqueName('prompt');
	const conventions = [
		'Test command: pnpm test',
		'Branch rules: branch from main',
		'PR expectations: focused, with a test',
		'Where things live: source is in apps/web/src'
	].join('\n');
	const created = await body<CreateProjectResponse>(
		await api.post('/api/v1/projects', {
			name: projectName,
			initial_prompt: conventions,
			starter: {
				id: 'code',
				inputs: {
					repo_url: `https://github.com/example/${repoName}.git`,
					repo_branch: 'main'
				}
			}
		})
	);
	const first = created.starter?.first_issue;
	expect(first).toMatchObject({ number: 1, state_name: 'In progress' });
	if (!first) throw new Error('the code starter did not create its first issue');

	const issue = await body<IssueDetail>(await api.get(`/api/v1/issues/${first.id}`));
	const submit = issue.allowed_transitions.find(
		(transition) => transition.name === 'Submit for review'
	);
	expect(submit?.requires).toEqual([
		expect.objectContaining({ artifact: 'pr', type: 'pr', status: 'missing' })
	]);
	const noBug = issue.allowed_transitions.find((transition) => transition.name === 'No bug found');
	expect(noBug).toBeDefined();
	expect(noBug?.requires).toBeUndefined();

	const prompt = await body<LaunchPromptResponse>(
		await api.get(`/api/v1/issues/${first.id}/prompt`)
	);
	expect(prompt.text).toContain(`## Context: project ${projectName}`);
	expect(prompt.text).toContain(conventions);
	expect(prompt.text).toContain('## Context: state In progress');
	expect(prompt.text).toContain('Unanswered template lines mean “not specified”');
	expect(prompt.text).toContain(`repo "${repoName}" (branch main)`);

	const workflow = execFileSync(TSX, [CLI_ENTRY, 'workflows', 'show', 'Code change'], {
		cwd: CLI_DIR,
		env: { ...process.env, TINES_API_KEY: ALICE.apiKey, TINES_API_URL: BASE_URL },
		encoding: 'utf8'
	});
	expect(workflow).toContain('"Submit for review": In progress → Review');
	expect(workflow).toContain('requires artifact "pr" (pr)');

	await page.goto(`/issues/${encodeURIComponent(projectName)}/1`);
	await expect(page.getByRole('button', { name: /Submit for review/ }).first()).toBeDisabled();

	const moved = await api.post(`/api/v1/issues/${first.id}/transition`, {
		action: 'No bug found'
	});
	expect(moved.ok(), 'the no-work fallback must not require a PR').toBe(true);
	const reviewed = await body<IssueDetail>(await api.get(`/api/v1/issues/${first.id}`));
	expect(reviewed.state.name).toBe('Review');
});

test('CLI applies Code and Plan through the same atomic starter endpoint', async ({
	request,
	uniqueName
}) => {
	const run = (args: string[]) =>
		JSON.parse(
			execFileSync(TSX, [CLI_ENTRY, ...args, '--json'], {
				cwd: CLI_DIR,
				env: { ...process.env, TINES_API_KEY: ALICE.apiKey, TINES_API_URL: BASE_URL },
				encoding: 'utf8'
			})
		) as CreateProjectResponse;
	const codeName = uniqueName('starter-cli-code');
	const code = run([
		'projects',
		'create',
		codeName,
		'--starter',
		'code',
		'--repo',
		`https://github.com/example/${codeName}.git`,
		'--branch',
		'main'
	]);
	expect(code.starter?.first_issue?.state_name).toBe('In progress');
	expect(code.starter?.context.map((item) => item.kind)).toEqual(['repo']);

	const plan = run([
		'projects',
		'create',
		uniqueName('starter-cli-plan'),
		'--starter',
		'plan',
		'--brief',
		'One day with children\nRainy-day backup'
	]);
	expect(plan.starter?.first_issue?.state_name).toBe('Scouting');
	expect(plan.starter?.context.map((item) => item.name)).toEqual(['planning-guide']);
	const issue = await body<IssueDetail>(
		await apiClient(request, ALICE.apiKey).get(`/api/v1/issues/${plan.starter!.first_issue!.id}`)
	);
	expect(issue.description).toContain('One day with children\nRainy-day backup');
});

/**
 * The project page does not name its default workflow, so the grid card —
 * which does — is where that acceptance criterion is checked. Called from the
 * project page it has just landed on.
 */
async function expectDefaultWorkflow(page: Page, name: string) {
	const href = new URL(page.url()).pathname;
	await page.goto('/projects');
	await expect(
		page.locator(`a[href="${href}"]`).filter({ hasText: `workflow: ${name}` })
	).toHaveCount(1);
}

/** Opens the New-project dialog on an already-hydrated /projects. */
async function openDialog(page: Page) {
	const dialog = page.getByRole('dialog', { name: 'New project' });
	await clickUntil(page.getByRole('button', { name: /New project/ }), async () => {
		await expect(dialog).toBeVisible({ timeout: 2_000 });
	});
	return dialog;
}

test('Blank is preselected and creates a project with only the conventions prompt', async ({
	page,
	uniqueName
}) => {
	await gotoHydrated(page, '/projects');
	const dialog = await openDialog(page);

	await expect(dialog.getByTestId('starter-blank')).toHaveAttribute('aria-checked', 'true');
	await expect(dialog.getByTestId('starter-code')).toHaveAttribute('aria-checked', 'false');
	// Blank asks for nothing beyond today's form.
	await expect(dialog.getByLabel('Repository URL')).toHaveCount(0);
	await expect(dialog.getByLabel('Name', { exact: true })).toHaveValue('');
	// The reworded label, and no developer-only wording (PRD success signal 7).
	await expect(dialog.getByLabel(/How work is done here/)).toBeVisible();
	await expect(dialog.getByText(/commands? that must pass/i)).toHaveCount(0);

	const name = uniqueName('starter-blank');
	await dialog.getByLabel('Name', { exact: true }).fill(name);
	await dialog.getByLabel(/How work is done here/).fill('Ask before deleting anything.');

	const creates = dialog.getByRole('list', { name: 'This creates' });
	await expect(creates).toHaveText(/Prompt “conventions”/);
	await expect(creates.getByRole('listitem')).toHaveCount(1);

	await dialog.getByRole('button', { name: 'Create project' }).click();
	await expect(page).toHaveURL(/\/projects\/prj_/);
	await expect(page.getByRole('heading', { name })).toBeVisible();
	await expect(page.getByRole('link', { name: 'Next: get an agent running' })).toHaveCount(0);
	// Context items are buttons (they open the editor), not links.
	await expect(page.getByRole('button', { name: /^conventions/ })).toBeVisible();
	await expect(page.getByText('No issues match these filters.')).toBeVisible();
});

test('Code repository asks for a URL, previews the repo item, and creates it', async ({
	page,
	uniqueName
}) => {
	await gotoHydrated(page, '/projects');
	const dialog = await openDialog(page);
	const code = byId('code');

	await dialog.getByTestId('starter-code').click();
	await expect(dialog.getByTestId('starter-code')).toHaveAttribute('aria-checked', 'true');
	// Both declared inputs, the optional one marked as such.
	await expect(dialog.getByLabel(code.inputs[0].label, { exact: false })).toBeVisible();
	await expect(dialog.getByLabel(/Branch.*optional/)).toBeVisible();

	// A pristine textarea mirrors the starter's template.
	const conventions = dialog.getByLabel(/How work is done here/);
	await expect(conventions).toHaveValue(code.conventions_template ?? '');

	// The required input is enforced before submit.
	await expect(dialog.getByRole('button', { name: 'Create project' })).toBeDisabled();
	const name = uniqueName('starter-code');
	await dialog
		.getByLabel(code.inputs[0].label, { exact: false })
		.fill(`https://github.com/example/${name}.git`);
	await expect(dialog.getByLabel('Name', { exact: true })).toHaveValue(name);
	await expect(dialog.getByRole('button', { name: 'Create project' })).toBeEnabled();

	const creates = dialog.getByRole('list', { name: 'This creates' });
	await expect(creates).toHaveText(new RegExp(`Repository “${name}”`));
	await expect(creates).toHaveText(/\(default\)/);
	await expect(creates).toHaveText(/Prompt “conventions”/);
	await expect(creates).toHaveText(new RegExp(`Issue “${code.creates.first_issue?.title}”`));

	await dialog.getByRole('button', { name: 'Create project' }).click();
	await expect(page).toHaveURL(/\/projects\/prj_/);
	await expect(page.getByText('First issue')).toBeVisible();
	await expect(page.getByRole('link', { name: 'Next: get an agent running' })).toHaveAttribute(
		'href',
		'/agents'
	);
	await expect(
		page.getByRole('link', { name: new RegExp(code.creates.first_issue?.title ?? 'nope') }).first()
	).toBeVisible();
	await expect(page.getByRole('button', { name: /^conventions/ })).toBeVisible();
	await expect(page.getByRole('button', { name: new RegExp(`^${name}`) })).toBeVisible();
	// The starter's own workflow is the project's default — the grid card is
	// where the project page does not say so itself.
	await expectDefaultWorkflow(page, code.creates.workflows.find((w) => w.default)?.name ?? '');
});

for (const viewport of [
	{ width: 1440, height: 900 },
	{ width: 390, height: 844 }
]) {
	test(`a ${viewport.width}px repository suggestion is capped and creates successfully`, async ({
		browser
	}) => {
		const context = await browser.newContext({ viewport });
		await signIn(context, ALICE.sessionToken);
		const page = await context.newPage();
		await gotoHydrated(page, '/projects');
		const dialog = await openDialog(page);
		await dialog.getByTestId('starter-code').click();

		const prefix = `starter-long-${viewport.width}-${runId}-`;
		const basename = prefix + 'x'.repeat(201 - prefix.length);
		const expectedName = basename.slice(0, 200);
		const remote = `https://github.com/example/${basename}.git`;
		const url = dialog.getByLabel('Repository URL');
		const name = dialog.getByLabel('Name', { exact: true });
		const hint = dialog.getByText('Maximum 200 characters.', { exact: true });
		const submit = dialog.getByRole('button', { name: 'Create project' });

		await url.fill(remote);
		await expect(name).toHaveValue(expectedName);
		await expect(url).toHaveValue(remote);
		await expect(name).toHaveAttribute('maxlength', '200');
		await expect(name).toHaveAttribute('aria-describedby', 'project-name-hint');
		await expect(hint).toBeVisible();
		await submit.scrollIntoViewIfNeeded();
		await expect(submit).toBeEnabled();

		const [createResponse] = await Promise.all([
			page.waitForResponse(
				(response) =>
					response.request().method() === 'POST' &&
					new URL(response.url()).pathname === '/api/v1/projects'
			),
			submit.click()
		]);
		expect(createResponse.status()).toBe(201);
		expect((await createResponse.json()).name).toBe(expectedName);
		await expect(page).toHaveURL(/\/projects\/prj_/);
		await expect(page.getByRole('heading', { name: expectedName })).toBeVisible();
		await context.close();
	});
}

test('Name exposes its limit and keeps a direct edit across starter changes', async ({ page }) => {
	await gotoHydrated(page, '/projects');
	const dialog = await openDialog(page);
	const name = dialog.getByLabel('Name', { exact: true });
	const hint = dialog.getByText('Maximum 200 characters.', { exact: true });

	await expect(name).toHaveAttribute('maxlength', '200');
	await expect(hint).toBeVisible();
	await name.fill('n'.repeat(200));
	await name.press('End');
	await name.press('x');
	await expect(name).toHaveValue('n'.repeat(200));

	await name.fill('manual-name');
	await dialog.getByTestId('starter-code').click();
	await dialog
		.getByLabel('Repository URL')
		.fill('https://github.com/example/a-different-repository.git');
	await expect(name).toHaveValue('manual-name');
	await dialog.getByTestId('starter-plan').click();
	await expect(name).toHaveValue('manual-name');
	await expect(hint).toBeVisible();
});

test('repository naming follows while pristine and freezes after any Name edit', async ({
	page
}) => {
	await gotoHydrated(page, '/projects');
	const dialog = await openDialog(page);
	const name = dialog.getByLabel('Name', { exact: true });
	const submit = dialog.getByRole('button', { name: 'Create project' });

	await dialog.getByTestId('starter-code').click();
	const url = dialog.getByLabel('Repository URL');
	await url.fill('https://github.com/example/first.git');
	await expect(name).toHaveValue('first');

	// Focus and blur do not claim ownership; the next URL still updates Name.
	await name.focus();
	await name.blur();
	await url.fill('git@git.example:team/second.git');
	await expect(name).toHaveValue('second');

	// Invalid and blank inputs clear only an untouched suggestion, then recover.
	await url.fill('not-a-url');
	await expect(name).toHaveValue('');
	await name.fill('manual-fallback');
	await expect(submit).toBeEnabled();

	// Editing and undoing to the suggested text still claims ownership.
	await name.fill('secondx');
	await name.press('Backspace');
	await expect(name).toHaveValue('second');
	await url.fill('https://github.com/example/third.git');
	await expect(name).toHaveValue('second');

	// A deliberate clear is preserved across URL and starter changes.
	await name.fill('');
	await expect(submit).toBeDisabled();
	await dialog.getByTestId('starter-blank').click();
	await expect(name).toHaveValue('');
	await dialog.getByTestId('starter-plan').click();
	await expect(name).toHaveValue('');
	await dialog.getByTestId('starter-code').click();
	await expect(url).toHaveValue('https://github.com/example/third.git');
	await expect(name).toHaveValue('');
});

test('pristine repository naming follows starter switches and resets after close', async ({
	page
}) => {
	await gotoHydrated(page, '/projects');
	let dialog = await openDialog(page);
	let name = dialog.getByLabel('Name', { exact: true });

	await dialog.getByTestId('starter-code').click();
	await dialog.getByLabel('Repository URL').fill('https://github.com/example/retained.git');
	await expect(name).toHaveValue('retained');
	await dialog.getByTestId('starter-blank').click();
	await expect(name).toHaveValue('');
	await dialog.getByTestId('starter-plan').click();
	await expect(name).toHaveValue('');
	await dialog.getByTestId('starter-code').click();
	await expect(name).toHaveValue('retained');

	await dialog.getByRole('button', { name: 'Cancel' }).click();
	dialog = await openDialog(page);
	name = dialog.getByLabel('Name', { exact: true });
	await expect(name).toHaveValue('');
	await dialog.getByTestId('starter-code').click();
	await expect(dialog.getByLabel('Repository URL')).toHaveValue('');
	await dialog.getByLabel('Repository URL').fill('https://github.com/example/escape.git');
	await expect(name).toHaveValue('escape');

	await page.keyboard.press('Escape');
	await expect(dialog).toHaveCount(0);
	dialog = await openDialog(page);
	await expect(dialog.getByLabel('Name', { exact: true })).toHaveValue('');
	await dialog.getByTestId('starter-code').click();
	await expect(dialog.getByLabel('Repository URL')).toHaveValue('');
});

test('a suggested duplicate name keeps the form intact and accepts a manual replacement', async ({
	page,
	request,
	uniqueName
}) => {
	const duplicate = uniqueName('starter-duplicate', { maxLength: 38 });
	const replacement = `${duplicate}-replacement`;
	const created = await apiClient(request, ALICE.apiKey).post('/api/v1/projects', {
		name: duplicate
	});
	expect(created.status()).toBe(201);

	await gotoHydrated(page, '/projects');
	const dialog = await openDialog(page);
	await dialog.getByTestId('starter-code').click();
	const url = dialog.getByLabel('Repository URL');
	const name = dialog.getByLabel('Name', { exact: true });
	const remote = `https://github.com/example/${duplicate}.git`;
	await url.fill(remote);
	await expect(name).toHaveValue(duplicate);
	await dialog.getByRole('button', { name: 'Create project' }).click();

	await expect(dialog.getByText(/already exists/)).toBeVisible();
	await expect(url).toHaveValue(remote);
	await expect(name).toHaveValue(duplicate);
	await name.fill(replacement);
	await dialog.getByRole('button', { name: 'Create project' }).click();
	await expect(page.getByRole('heading', { name: replacement })).toBeVisible();
});

test('clearing the prefilled conventions creates a project without one', async ({
	page,
	uniqueName
}) => {
	// The dialog sends `initial_prompt` verbatim, so an emptied textarea must
	// mean "no conventions item". Were it sent as `undefined` instead, the
	// server would fall back to the starter's own template and seed the very
	// prompt the user just deleted.
	await gotoHydrated(page, '/projects');
	const dialog = await openDialog(page);
	const code = byId('code');

	await dialog.getByTestId('starter-code').click();
	const name = uniqueName('starter-noconv');
	await dialog.getByLabel('Name', { exact: true }).fill(name);
	await dialog
		.getByLabel(code.inputs[0].label, { exact: false })
		.fill(`https://github.com/example/noconv-${runId}.git`);

	const conventions = dialog.getByLabel(/How work is done here/);
	await expect(conventions).toHaveValue(code.conventions_template ?? '');
	await conventions.fill('');

	// The preview stops promising it, too.
	const creates = dialog.getByRole('list', { name: 'This creates' });
	await expect(creates).toHaveText(new RegExp(`Repository “noconv-${runId}”`));
	await expect(creates).not.toHaveText(/Prompt “conventions”/);

	await dialog.getByRole('button', { name: 'Create project' }).click();
	await expect(page).toHaveURL(/\/projects\/prj_/);
	await expect(page.getByRole('heading', { name })).toBeVisible();
	// The repo item is there — so the starter did apply — and the prompt is not.
	await expect(page.getByRole('button', { name: new RegExp(`^noconv-${runId}`) })).toBeVisible();
	await expect(page.getByRole('button', { name: /^conventions/ })).toHaveCount(0);
});

test('Plan something together renders a multiline brief and lands on its first issue', async ({
	page,
	request,
	uniqueName
}) => {
	await gotoHydrated(page, '/projects');
	const dialog = await openDialog(page);
	const plan = byId('plan');

	await dialog.getByTestId('starter-plan').click();
	await expect(dialog.getByLabel('Name', { exact: true })).toHaveValue('');
	const brief = `Two adults and two children ${runId}\nOutdoor options and a rainy-day backup`;
	const briefInput = dialog.getByLabel(plan.inputs[0].label, { exact: false });
	await expect(briefInput.evaluate((element) => element.tagName)).resolves.toBe('TEXTAREA');
	await briefInput.fill(brief);
	await expect(briefInput).toHaveValue(brief);

	// Both the pristine textarea and the preview follow the brief live.
	await expect(dialog.getByLabel(/How work is done here/)).toHaveValue(new RegExp(brief));
	const creates = dialog.getByRole('list', { name: 'This creates' });
	await expect(creates).toHaveText(new RegExp(brief));

	const name = uniqueName('starter-plan');
	await dialog.getByLabel('Name', { exact: true }).fill(name);
	await dialog.getByRole('button', { name: 'Create project' }).click();

	await expect(page).toHaveURL(/\/projects\/prj_/);
	const title = plan.creates.first_issue?.title.replace('{{ brief }}', brief) ?? 'nope';
	await expect(page.getByRole('link', { name: title }).first()).toBeVisible();
	await expect(page.getByRole('link', { name: 'Next: get an agent running' })).toBeVisible();
	await expect(page.getByRole('button', { name: /^conventions/ })).toBeVisible();
	await expect(page.getByRole('button', { name: /^planning-guide/ })).toBeVisible();
	const projectId = new URL(page.url()).pathname.split('/').at(-1)!;
	const listed = await body<{ items: { id: string }[] }>(
		await apiClient(request, ALICE.apiKey).get(`/api/v1/issues?project=${projectId}`)
	);
	const persisted = await body<IssueDetail>(
		await apiClient(request, ALICE.apiKey).get(`/api/v1/issues/${listed.items[0].id}`)
	);
	expect(persisted.description).toContain(brief);
	await page.reload();
	await expect(page.getByRole('link', { name: 'Next: get an agent running' })).toHaveCount(0);
	await expectDefaultWorkflow(page, plan.creates.workflows.find((w) => w.default)?.name ?? '');
});

test('switching starters confirms before discarding edited conventions', async ({ page }) => {
	await gotoHydrated(page, '/projects');
	const dialog = await openDialog(page);
	const plan = byId('plan');

	await dialog.getByTestId('starter-code').click();
	const conventions = dialog.getByLabel(/How work is done here/);
	await conventions.fill('Mine, hand-written.');

	// Keep mine: the starter still switches, the text does not.
	await dialog.getByTestId('starter-plan').click();
	const confirm = page.getByRole('alertdialog');
	await expect(confirm.getByText('Replace your conventions?')).toBeVisible();
	await confirm.getByRole('button', { name: 'Keep mine' }).click();
	await expect(dialog.getByTestId('starter-plan')).toHaveAttribute('aria-checked', 'true');
	await expect(conventions).toHaveValue('Mine, hand-written.');

	// Replace: the new starter's template wins.
	await dialog.getByTestId('starter-code').click();
	await expect(page.getByRole('alertdialog').getByText('Replace your conventions?')).toBeVisible();
	await page.getByRole('alertdialog').getByRole('button', { name: 'Replace' }).click();
	await expect(dialog.getByTestId('starter-code')).toHaveAttribute('aria-checked', 'true');
	// Code's template has no placeholders, so it renders verbatim.
	await expect(conventions).toHaveValue(byId('code').conventions_template ?? '');
	// And it is pristine again: switching back to Plan swaps it with no prompt.
	await dialog.getByTestId('starter-plan').click();
	await expect(page.getByRole('alertdialog')).toHaveCount(0);
	await expect(conventions).not.toHaveValue(byId('code').conventions_template ?? '');
	expect(plan.conventions_template).not.toBeNull();

	// A starter with no template discards the text rather than replacing it,
	// and says so: promising a swap and then emptying the field is a lie.
	const blank = byId('blank');
	expect(blank.conventions_template, 'blank must have no template').toBeNull();
	await conventions.fill('Mine again.');
	await dialog.getByTestId('starter-blank').click();
	const discard = page.getByRole('alertdialog');
	await expect(discard).toContainText(new RegExp(`discards the text you edited`));
	await expect(discard).toContainText(blank.name);
	await expect(discard).not.toContainText(/with its template/);
	await discard.getByRole('button', { name: 'Replace' }).click();
	await expect(conventions).toHaveValue('');
});

test('a starter 422 from the API is surfaced in the dialog, not swallowed', async ({
	page,
	uniqueName
}) => {
	await gotoHydrated(page, '/projects');
	const dialog = await openDialog(page);
	const code = byId('code');
	const branch = code.inputs.find((i) => i.key === 'repo_branch');
	expect(branch?.max, 'the branch input must have a server-side cap to violate').toBeGreaterThan(0);

	await dialog.getByTestId('starter-code').click();
	const name = uniqueName('starter-422');
	await dialog.getByLabel('Name', { exact: true }).fill(name);
	await dialog
		.getByLabel(code.inputs[0].label, { exact: false })
		.fill('https://github.com/example/toolong.git');
	// The dialog does not cap this client-side, so the server's 422 is the only
	// thing standing between the user and a confusing silent failure.
	await dialog.getByLabel(/Branch/).fill('b'.repeat((branch?.max ?? 200) + 1));
	await dialog.getByRole('button', { name: 'Create project' }).click();

	await expect(dialog.getByText(/longer than \d+ characters/)).toBeVisible();
	// Still open, with the user's input intact.
	await expect(dialog).toBeVisible();
	await expect(dialog.getByLabel('Name', { exact: true })).toHaveValue(name);
});

test('at 390px the chooser stacks and the whole form stays reachable', async ({
	browser,
	uniqueName
}) => {
	const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
	await signIn(context, ALICE.sessionToken);
	const page = await context.newPage();
	await gotoHydrated(page, '/projects');
	const dialog = await openDialog(page);

	const boxes = [];
	for (const starter of starters) {
		const box = await dialog.getByTestId(`starter-${starter.id}`).boundingBox();
		expect(box, `starter-${starter.id} must be laid out`).not.toBeNull();
		boxes.push(box!);
	}
	// Stacked: each card starts below the last, and they share a left edge.
	for (let i = 1; i < boxes.length; i++) {
		expect(boxes[i].y).toBeGreaterThan(boxes[i - 1].y);
		expect(Math.abs(boxes[i].x - boxes[0].x)).toBeLessThan(2);
	}
	// The dialog itself fits the viewport horizontally.
	const dialogBox = (await dialog.boundingBox())!;
	expect(dialogBox.x).toBeGreaterThanOrEqual(0);
	expect(dialogBox.x + dialogBox.width).toBeLessThanOrEqual(390);

	// Every input remains reachable by scrolling the dialog.
	await dialog.getByTestId('starter-code').click();
	const url = dialog.getByLabel(byId('code').inputs[0].label, { exact: false });
	await url.scrollIntoViewIfNeeded();
	await url.fill('https://github.com/example/phone.git');
	await expect(dialog.getByLabel('Name', { exact: true })).toHaveValue('phone');
	const submit = dialog.getByRole('button', { name: 'Create project' });
	await submit.scrollIntoViewIfNeeded();
	await expect(submit).toBeVisible();
	await expect(submit).toBeEnabled();

	await dialog.getByTestId('starter-plan').click();
	await dialog.getByLabel('What are you planning?', { exact: false }).fill('x'.repeat(10_000));
	const previewRows = dialog.getByRole('list', { name: 'This creates' }).getByRole('listitem');
	const previewHeight = await previewRows.evaluateAll((rows) =>
		rows.reduce((height, row) => height + row.getBoundingClientRect().height, 0)
	);
	expect(previewHeight).toBeLessThan(300);
	expect(await dialog.evaluate((element) => element.scrollHeight)).toBeLessThan(1_600);
	await submit.scrollIntoViewIfNeeded();
	await expect(submit).toBeVisible();

	await context.close();
});
