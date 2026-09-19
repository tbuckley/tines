import type { IssueDetail, ListResponse, Project } from '@tines/shared';
import { expect, test } from './fixtures';
import { ALICE } from './constants.mjs';
import { body, clickToOpen, gotoHydrated, issuePath, PHONE, resetFocus } from './helpers';

let prefix: string;
let canonicalProject: Project;
let mixedProject: Project;
let duplicateOnlyProject: Project;
let canonical: IssueDetail;
let ordinary: IssueDetail;
let duplicate: IssueDetail;
let onlyDuplicate: IssueDetail;

test.beforeAll(async ({ apiFor, uniqueName }) => {
	prefix = uniqueName('duplicate-list', { maxLength: 40 });
	const api = apiFor(ALICE);
	canonicalProject = await body<Project>(
		await api.post('/api/v1/projects', { name: uniqueName('duplicate-canonical') })
	);
	mixedProject = await body<Project>(
		await api.post('/api/v1/projects', { name: uniqueName('duplicate-mixed') })
	);
	duplicateOnlyProject = await body<Project>(
		await api.post('/api/v1/projects', { name: uniqueName('duplicate-only') })
	);
	canonical = await body<IssueDetail>(
		await api.post(`/api/v1/projects/${canonicalProject.id}/issues`, {
			title: `${prefix} canonical`
		})
	);
	ordinary = await body<IssueDetail>(
		await api.post(`/api/v1/projects/${mixedProject.id}/issues`, {
			title: `${prefix} ordinary`
		})
	);
	duplicate = await body<IssueDetail>(
		await api.post(`/api/v1/projects/${mixedProject.id}/issues`, {
			title: `${prefix} duplicate`
		})
	);
	onlyDuplicate = await body<IssueDetail>(
		await api.post(`/api/v1/projects/${duplicateOnlyProject.id}/issues`, {
			title: `${prefix} only duplicate`
		})
	);
	for (const issue of [duplicate, onlyDuplicate]) {
		expect(
			(
				await api.post(`/api/v1/issues/${issue.id}/links`, {
					kind: 'duplicate_of',
					issue_id: canonical.id
				})
			).status()
		).toBe(201);
	}
});

test.use({ signedIn: ALICE });

test.beforeEach(async ({ request }) => {
	await resetFocus(request);
});

test('API and global list hide duplicates by default and the filter restores them', async ({
	apiFor,
	page
}) => {
	const api = apiFor(ALICE);
	const query = `q=${encodeURIComponent(prefix)}`;
	const hidden = await body<ListResponse<IssueDetail>>(await api.get(`/api/v1/issues?${query}`));
	expect(hidden.items.map((issue) => issue.id).sort()).toEqual([canonical.id, ordinary.id].sort());
	const shown = await body<ListResponse<IssueDetail>>(
		await api.get(`/api/v1/issues?${query}&hide_duplicates=false`)
	);
	expect(shown.items.map((issue) => issue.id).sort()).toEqual(
		[canonical.id, ordinary.id, duplicate.id, onlyDuplicate.id].sort()
	);

	await gotoHydrated(page, `/issues?${query}`);
	await expect(page.getByRole('link', { name: duplicate.title })).toHaveCount(0);
	await expect(page.getByRole('link', { name: ordinary.title })).toBeVisible();
	const categories = page.getByRole('navigation', { name: 'Category' });
	await expect(categories.getByRole('link', { name: 'Active 2', exact: true })).toBeVisible();

	await clickToOpen(
		page.getByRole('button', { name: /^Filter/ }),
		page.getByRole('checkbox', { name: 'Show duplicates' })
	);
	await page.getByRole('checkbox', { name: 'Show duplicates' }).check();
	await expect(page).toHaveURL(/duplicates=1/);
	const duplicateRow = page.getByRole('link', { name: duplicate.title });
	await expect(duplicateRow).toBeVisible();
	await expect(duplicateRow.getByText('dup', { exact: true })).toBeVisible();
	await expect(categories.getByRole('link', { name: 'Active 4', exact: true })).toBeVisible();
	await expect(page.getByRole('button', { name: 'Hide duplicates' })).toBeVisible();

	await page.reload({ waitUntil: 'networkidle' });
	await expect(duplicateRow).toBeVisible();
	await categories.getByRole('link', { name: /^Active/ }).click();
	await expect(page).toHaveURL(/duplicates=1/);
	await expect(page).toHaveURL(new RegExp(`q=${encodeURIComponent(prefix)}`));

	await duplicateRow.click();
	await expect(page).toHaveURL(issuePath(mixedProject.name, duplicate.number));
	await expect(page.getByText('Duplicate of', { exact: true })).toBeVisible();
	const duplicateBanner = page.getByRole('button', { name: 'Not a duplicate?' }).locator('..');
	await expect(
		duplicateBanner.getByRole('link', {
			name: `${canonicalProject.name}/#${canonical.number}`,
			exact: true
		})
	).toHaveAttribute('href', issuePath(canonicalProject.name, canonical.number));
	await page.goBack({ waitUntil: 'networkidle' });
	await expect(duplicateRow).toBeVisible();

	await page.getByRole('button', { name: 'Hide duplicates' }).click();
	await expect(page).not.toHaveURL(/duplicates=1/);
	await expect(page.getByRole('link', { name: duplicate.title })).toHaveCount(0);
});

test('project list has truthful counts and keyboard-operable duplicate controls on a phone', async ({
	apiFor,
	page
}) => {
	const api = apiFor(ALICE);
	const hidden = await body<ListResponse<IssueDetail>>(
		await api.get(`/api/v1/projects/${duplicateOnlyProject.id}/issues`)
	);
	expect(hidden.items).toEqual([]);
	const shown = await body<ListResponse<IssueDetail>>(
		await api.get(`/api/v1/projects/${duplicateOnlyProject.id}/issues?hide_duplicates=false`)
	);
	expect(shown.items.map((issue) => issue.id)).toEqual([onlyDuplicate.id]);

	await page.setViewportSize(PHONE);
	await gotoHydrated(page, `/projects/${duplicateOnlyProject.id}`);
	await expect(page.getByText('No issues match these filters.')).toBeVisible();
	const categories = page.getByRole('navigation', { name: 'Category' });
	await expect(categories.getByRole('link', { name: 'Active 0', exact: true })).toBeVisible();
	await clickToOpen(
		page.getByRole('button', { name: /^Filter/ }),
		page.getByRole('checkbox', { name: 'Show duplicates' })
	);
	const checkbox = page.getByRole('checkbox', { name: 'Show duplicates' });
	await checkbox.focus();
	await page.keyboard.press('Space');
	await expect(page).toHaveURL(/duplicates=1/);
	await expect(page.getByRole('link', { name: onlyDuplicate.title })).toBeVisible();
	await expect(categories.getByRole('link', { name: 'Active 1', exact: true })).toBeVisible();
	await page.reload({ waitUntil: 'networkidle' });
	await expect(page.getByRole('link', { name: onlyDuplicate.title })).toBeVisible();
	await expect(
		page.evaluate(
			() => document.documentElement.scrollWidth <= document.documentElement.clientWidth
		)
	).resolves.toBe(true);

	await clickToOpen(
		page.getByRole('button', { name: /^Filter/ }),
		page.getByRole('checkbox', { name: 'Show duplicates' })
	);
	await page.getByRole('button', { name: 'Clear filters' }).click();
	await expect(page).not.toHaveURL(/duplicates=1/);
	await expect(page.getByRole('link', { name: onlyDuplicate.title })).toHaveCount(0);
});

test('direct duplicate selectors remain available outside ordinary lists', async ({ page }) => {
	await gotoHydrated(page, issuePath(mixedProject.name, ordinary.number));
	const relations = page.locator('#relations');
	await relations.getByRole('button', { name: 'Add' }).click();
	const picker = relations.getByRole('combobox', { name: 'Issue to link' });
	await picker.fill(duplicate.title);
	await expect(relations.getByRole('button', { name: new RegExp(duplicate.title) })).toBeVisible();

	await gotoHydrated(page, `/projects/${mixedProject.id}`);
	await page.getByRole('button', { name: 'Add context' }).click();
	await expect(page.getByRole('heading', { name: 'New context item' })).toBeVisible();
	const issueScope = page.getByLabel('Only for issue');
	await expect(issueScope.locator(`option[value="${duplicate.id}"]`)).toHaveText(
		`${mixedProject.name}/${duplicate.number} — ${duplicate.title}`
	);
});
