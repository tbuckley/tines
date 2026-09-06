import type { IssueDetail, Project } from '@tines/shared';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { ALICE } from './constants.mjs';
import { apiClient, body, clickUntil, gotoHydrated, resetFocus, runId, signIn } from './helpers';

// Specs share one user: a project page sets the focus (Tines/259), so clear it
// before each test rather than letting it scope a later spec's lists.
test.beforeEach(async ({ request }) => {
	await resetFocus(request);
});

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
			await gotoHydrated(page, path);
			return page;
		}

		test('seeds a project with one issue', async ({ request }) => {
			const api = apiClient(request, ALICE.apiKey);
			const project = await body<Project>(
				await api.post('/api/v1/projects', { name: projectName, description: 'archive me' })
			);
			projectId = project.id;
			const issue = await body<IssueDetail>(
				await api.post(`/api/v1/projects/${project.id}/issues`, {
					title: `${projectName} issue`
				})
			);
			issueNumber = issue.number;
		});

		test('Settings archives the project, and the page goes read-only', async ({ browser }) => {
			const page = await open(browser, `/projects/${projectId}`);

			// The first click can land before hydration, and the modal never opens.
			const archiveButton = page.getByRole('button', { name: 'Archive project' });
			await clickUntil(page.getByRole('button', { name: 'Settings' }), async () => {
				await expect(archiveButton).toBeVisible();
			});
			await archiveButton.click();

			// The shared confirm is bits-ui's alert-dialog variant.
			const dialog = page.getByRole('alertdialog');
			await expect(dialog).toContainText('makes its 1 issue read-only');
			await expect(dialog).toContainText('Runs already under way are allowed to finish');
			await dialog.getByRole('button', { name: 'Archive project' }).click();

			await expect(page.getByText(/^Archived /)).toBeVisible();
			await expect(page.getByRole('button', { name: 'New issue' })).toHaveCount(0);
			await expect(page.getByRole('button', { name: 'Add context' })).toHaveCount(0);

			await clickUntil(page.getByRole('button', { name: 'Settings' }), async () => {
				await expect(page.getByRole('button', { name: 'Unarchive' }).first()).toBeVisible();
			});
			await expect(page.getByLabel('Name')).toBeDisabled();
			await page.close();
		});

		test('the grid hides the project behind the Show archived toggle', async ({ browser }) => {
			const page = await open(browser, '/projects');
			const card = page.getByRole('link', { name: projectName });
			await expect(card).toHaveCount(0);

			// The toggle only navigates once its listener is attached; a click that
			// lands before hydration flips nothing and leaves the URL bare.
			const toggle = page.getByRole('checkbox', { name: /^Show archived \(\d+\)$/ });
			await expect(toggle).toBeVisible();
			await clickUntil(toggle, async () => {
				await expect(page).toHaveURL(/\?archived=1$/);
			});

			await expect(card).toBeVisible();
			await expect(card).toContainText('Archived');
			// The Projects entry point remembers the toggle for the next visit —
			// the desktop tab and the phone's bottom-bar slot are the same link.
			await expect(page.getByRole('link', { name: 'Projects' }).first()).toHaveAttribute(
				'href',
				'/projects?archived=1'
			);

			await clickUntil(toggle, async () => {
				await expect(card).toHaveCount(0);
			});
			await page.close();
		});

		test('every project picker omits the archived project', async ({ browser }) => {
			// /issues has no project select at all now: the chrome owns the scope
			// (Tines/259), and the switcher never lists an archived project.
			const page = await open(browser, '/issues');
			await expect(page.getByLabel('Filter by project')).toHaveCount(0);

			for (const path of ['/context', '/activity']) {
				await gotoHydrated(page, path);
				await expect(page.getByLabel('Filter by project')).not.toContainText(projectName);
			}
			await page.close();
		});

		test('a stale ?project= URL names the archived project instead of emptying', async ({
			browser
		}) => {
			const page = await open(browser, `/issues?project=${encodeURIComponent(projectName)}`);
			// The one-shot cannot focus a frozen project, so it writes nothing and
			// says so; the list stays as it was rather than emptying.
			await expect(page.getByRole('status')).toContainText(`Project “${projectName}” is archived.`);
			await expect(page.getByRole('link', { name: 'View project' })).toHaveAttribute(
				'href',
				`/projects/${projectId}`
			);
			await expect(
				page.getByRole('link', { name: new RegExp(`${projectName} issue`) })
			).toHaveCount(0);
			// Unfocused, so the rest of the list is still there under All projects.
			await expect(page.getByRole('link', { name: /#\d+/ }).first()).toBeVisible();
			await page.close();
		});

		test('the issue page reads normally and writes nowhere', async ({ browser }) => {
			const page = await open(browser, `/issues/${encodeURIComponent(projectName)}/${issueNumber}`);
			await expect(page.getByText('This project is archived — read-only.')).toBeVisible();

			const comment = page.getByRole('button', { name: 'Comment' });
			await expect(comment).toBeDisabled();
			await expect(comment).toHaveAttribute('title', TOOLTIP);
			// Reads stay live. (The context header sits inside a fold on a phone, so
			// the launch-prompt button is only on screen at desktop width.)
			await expect(page.getByRole('heading', { name: `${projectName} issue` })).toBeVisible();
			if (label === 'desk') {
				await expect(page.getByRole('button', { name: 'View launch prompt' })).toBeEnabled();
			}
			await page.close();
		});

		test('Unarchive restores the project', async ({ browser }) => {
			const page = await open(browser, `/projects/${projectId}`);
			await clickUntil(page.getByRole('button', { name: 'Unarchive' }).first(), async () => {
				await expect(page.getByText(/^Archived /)).toHaveCount(0);
			});

			await expect(page.getByRole('button', { name: 'New issue' })).toBeVisible();
			await page.close();
		});
	});
}

suite('desk', { width: 1440, height: 900 });
suite('phone', { width: 390, height: 844 });
