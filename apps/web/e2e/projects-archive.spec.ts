import type { CreateIssueResponse, Project } from '@tines/shared';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { ALICE } from './constants.mjs';
import { apiClient, body, runId, signIn } from './helpers';

/**
 * Project archiving in the browser (Tines/207): archive → grid toggle → issue
 * page read-only → unarchive, at desktop and phone widths.
 *
 * Each viewport seeds its own project and unarchives it before the file ends,
 * so the shared e2e database is left exactly as it was found — other specs'
 * unfiltered project lists depend on it.
 */
const TOOLTIP = 'Project archived — unarchive to make changes';

function suite(label: string, viewport: { width: number; height: number }) {
	test.describe.serial(`project archive (${label})`, () => {
		const projectName = `pa-${label}-${runId}`;
		let projectId: string;
		let issueNumber: number;

		async function open(browser: Browser, path: string): Promise<Page> {
			const context = await browser.newContext({ viewport });
			await signIn(context, ALICE.sessionToken);
			const page = await context.newPage();
			await page.goto(path);
			return page;
		}

		test('seeds a project with one issue', async ({ request }) => {
			const api = apiClient(request, ALICE.apiKey);
			const project = await body<Project>(
				await api.post('/api/v1/projects', { name: projectName, description: 'archive me' })
			);
			projectId = project.id;
			const issue = await body<CreateIssueResponse>(
				await api.post('/api/v1/issues', { project: projectName, title: `${projectName} issue` })
			);
			issueNumber = issue.issue.number;
		});

		test('Settings archives the project, and the page goes read-only', async ({ browser }) => {
			const page = await open(browser, `/projects/${projectId}`);

			await page.getByRole('button', { name: 'Settings' }).click();
			await page.getByRole('button', { name: 'Archive project' }).click();

			// The shared confirm is bits-ui's alert-dialog variant.
			const dialog = page.getByRole('alertdialog');
			await expect(dialog).toContainText('makes its 1 issue read-only');
			await expect(dialog).toContainText('Runs already under way are allowed to finish');
			await dialog.getByRole('button', { name: 'Archive project' }).click();

			await expect(page.getByText(/^Archived /)).toBeVisible();
			await expect(page.getByRole('button', { name: 'New issue' })).toHaveCount(0);
			await expect(page.getByRole('button', { name: 'Add context' })).toHaveCount(0);

			await page.getByRole('button', { name: 'Settings' }).click();
			await expect(page.getByRole('button', { name: 'Unarchive' }).first()).toBeVisible();
			await expect(page.getByLabel('Name')).toBeDisabled();
			await page.close();
		});

		test('the grid hides the project behind the Show archived toggle', async ({ browser }) => {
			const page = await open(browser, '/projects');
			const card = page.getByRole('link', { name: projectName });
			await expect(card).toHaveCount(0);

			const toggle = page.getByRole('checkbox', { name: /^Show archived \(\d+\)$/ });
			await expect(toggle).toBeVisible();
			await toggle.click();

			await expect(page).toHaveURL(/\?archived=1$/);
			await expect(card).toBeVisible();
			await expect(card).toContainText('Archived');
			// The Projects nav tab remembers the toggle for the next visit.
			await expect(page.getByRole('link', { name: 'Projects' }).first()).toHaveAttribute(
				'href',
				'/projects?archived=1'
			);

			await toggle.click();
			await expect(card).toHaveCount(0);
			await page.close();
		});

		test('every project picker omits the archived project', async ({ browser }) => {
			const page = await open(browser, '/issues');
			await expect(page.getByLabel('Filter by project')).not.toContainText(projectName);

			for (const path of ['/context', '/activity']) {
				await page.goto(path);
				await expect(page.getByLabel('Filter by project')).not.toContainText(projectName);
			}
			await page.close();
		});

		test('a stale ?project= URL names the archived project instead of emptying', async ({
			browser
		}) => {
			const page = await open(browser, `/issues?project=${encodeURIComponent(projectName)}`);
			await expect(page.getByLabel('Filter by project')).toHaveValue(projectName);
			await expect(page.getByLabel('Filter by project')).toContainText(`${projectName} (archived)`);
			await expect(page.getByRole('link', { name: new RegExp(`${projectName} issue`) })).toBeVisible();
			await page.close();
		});

		test('the issue page reads normally and writes nowhere', async ({ browser }) => {
			const page = await open(
				browser,
				`/issues/${encodeURIComponent(projectName)}/${issueNumber}`
			);
			await expect(
				page.getByText('This project is archived — read-only.')
			).toBeVisible();

			const comment = page.getByRole('button', { name: 'Comment' });
			await expect(comment).toBeDisabled();
			await expect(comment).toHaveAttribute('title', TOOLTIP);
			// Reads stay live.
			await expect(page.getByRole('button', { name: 'View launch prompt' })).toBeEnabled();
			await page.close();
		});

		test('Unarchive restores the project', async ({ browser }) => {
			const page = await open(browser, `/projects/${projectId}`);
			await page.getByRole('button', { name: 'Unarchive' }).first().click();

			await expect(page.getByText(/^Archived /)).toHaveCount(0);
			await expect(page.getByRole('button', { name: 'New issue' })).toBeVisible();
			await page.close();
		});
	});
}

suite('desk', { width: 1440, height: 900 });
suite('phone', { width: 390, height: 844 });
