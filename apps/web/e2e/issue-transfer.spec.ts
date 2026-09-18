import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { EffectiveContext, IssueDetail, IssueTransferPreview, Project } from '@tines/shared';
import type { Browser, Page } from '@playwright/test';
import { expect, test as base } from './fixtures';
import { ALICE, BASE_URL } from './constants.mjs';
import { apiClient, body, clickToOpen, gotoHydrated, resetFocus, signIn } from './helpers';

const CLI_DIR = fileURLToPath(new URL('../../../packages/cli', import.meta.url));
const TSX = join(CLI_DIR, 'node_modules', '.bin', 'tsx');
const CLI_ENTRY = join(CLI_DIR, 'src', 'index.ts');

// Specs share one user: a project page sets the focus (Tines/259), so clear it
// before each test rather than letting it scope a later spec's lists.
base.beforeEach(async ({ request }) => {
	await resetFocus(request);
});

type TransferWorld = {
	sourceName: string;
	destinationName: string;
	longName: string;
	issueId: string;
	sourceId: string;
	sourceNumber: number;
	longId: string;
	conflictIds: Record<string, string>;
};

/**
 * "Move to project…" in the browser (Tines/392): choose a destination, inspect
 * the review, cancel with nothing written, then confirm and land on the
 * issue's new canonical address — at desktop and phone widths.
 *
 * Each viewport seeds its own source and destination projects, and the
 * destination already holds an issue, so the number the move allocates is
 * demonstrably the destination's next one and not the number carried over.
 */
function suite(label: string, viewport: { width: number; height: number }) {
	async function open(browser: Browser, path: string): Promise<Page> {
		const context = await browser.newContext({ viewport });
		await signIn(context, ALICE.sessionToken);
		const page = await context.newPage();
		await gotoHydrated(page, path);
		return page;
	}

	const test = base.extend<{}, { world: TransferWorld }>({
		world: [
			async ({ apiFor, uniqueName }, use) => {
				const sourceName = uniqueName(`xf-src-${label}`);
				const destinationName = uniqueName(`xf-dst-${label}`);
				const longName = `xf-${label}-` + 'destination'.repeat(17);
				const api = apiFor(ALICE);

				const source = await body<Project>(
					await api.post('/api/v1/projects', { name: sourceName, description: 'move from here' })
				);
				const sourceId = source.id;
				const destination = await body<Project>(
					await api.post('/api/v1/projects', { name: destinationName, description: 'move to here' })
				);
				const longId = (await body<Project>(await api.post('/api/v1/projects', { name: longName })))
					.id;
				// The destination's first number is taken, so the move cannot keep
				// the issue's old one.
				await body<IssueDetail>(
					await api.post(`/api/v1/projects/${destination.id}/issues`, { title: 'already here' })
				);
				// Guidance the issue loses, guidance it gains: the review has to
				// name both.
				await api.post('/api/v1/context', {
					kind: 'prompt',
					name: `source-only-${label}`,
					project_id: source.id,
					body: 'Guidance that stays behind'
				});
				await api.post('/api/v1/context', {
					kind: 'prompt',
					name: `destination-only-${label}`,
					project_id: destination.id,
					body: 'Guidance the issue picks up'
				});
				await api.post('/api/v1/context', {
					kind: 'repo',
					name: 'app',
					project_id: source.id,
					repo_url: 'https://example.test/source.git',
					repo_dir: 'app'
				});
				await api.post('/api/v1/context', {
					kind: 'repo',
					name: 'app',
					project_id: destination.id,
					repo_url: 'https://example.test/destination.git',
					repo_dir: 'app'
				});
				const issue = await body<IssueDetail>(
					await api.post(`/api/v1/projects/${source.id}/issues`, {
						title: `${sourceName} traveller`,
						description: 'Carries its whole record'
					})
				);
				const issueId = issue.id;
				const sourceNumber = issue.number;
				await api.post('/api/v1/context', {
					kind: 'prompt',
					name: `retained-prompt-${label}`,
					issue_id: issue.id,
					body: 'Retained issue prompt body'
				});
				await api.post('/api/v1/context', {
					kind: 'skill',
					name: `retained-skill-${label}`,
					issue_id: issue.id,
					files: [
						{ path: 'SKILL.md', content: 'Retained skill instructions' },
						{ path: 'checklist.md', content: 'Retained second file' }
					]
				});
				await api.post('/api/v1/context', {
					kind: 'repo',
					name: 'app',
					issue_id: issue.id,
					repo_url: 'https://example.test/issue-override.git',
					repo_branch: 'research',
					repo_dir: 'app'
				});
				const conflictIds: Record<string, string> = {};
				for (const fixture of [
					{
						key: 'retainedA',
						name: `retained-api-${label}`,
						issue_id: issue.id,
						dir: 'retained-checkout'
					},
					{
						key: 'retainedB',
						name: `retained-worker-${label}`,
						issue_id: issue.id,
						dir: 'retained-checkout'
					},
					{
						key: 'sourceA',
						name: `source-api-${label}`,
						project_id: source.id,
						dir: 'source-checkout'
					},
					{
						key: 'sourceB',
						name: `source-worker-${label}`,
						project_id: source.id,
						dir: 'source-checkout'
					},
					{
						key: 'destinationA',
						name: `destination-api-${label}`,
						project_id: destination.id,
						dir: 'destination-checkout'
					},
					{
						key: 'destinationB',
						name: `destination-worker-${label}`,
						project_id: destination.id,
						dir: 'destination-checkout'
					}
				]) {
					const created = await body<{ id: string }>(
						await api.post('/api/v1/context', {
							kind: 'repo',
							name: fixture.name,
							issue_id: fixture.issue_id,
							project_id: fixture.project_id,
							repo_url: `https://example.test/${fixture.name}.git`,
							repo_dir: fixture.dir
						})
					);
					conflictIds[fixture.key] = created.id;
				}
				expect(
					(
						await api.post(`/api/v1/issues/${issue.id}/comments`, {
							body: 'a comment that survives'
						})
					).status()
				).toBe(201);
				await use({
					sourceName,
					destinationName,
					longName,
					issueId,
					sourceId,
					sourceNumber,
					longId,
					conflictIds
				});
			},
			{ scope: 'worker' }
		]
	});

	test.describe.serial(`issue transfer (${label})`, () => {
		test('focuses the chooser and contains a long unbroken destination', async ({
			browser,
			world
		}) => {
			const { sourceName, sourceNumber, longId, longName } = world;
			const page = await open(browser, `/issues/${sourceName}/${sourceNumber}`);
			const modal = page.getByRole('dialog');
			await clickToOpen(page.getByTestId('move-to-project'), modal);
			const chooser = modal.getByTestId('transfer-destination');
			await expect(chooser).toBeFocused();
			await chooser.selectOption(longId);
			await modal.getByRole('button', { name: 'Review move' }).click();
			const heading = modal.getByRole('heading', { level: 3 });
			await expect(heading).toBeFocused();
			await expect(heading).toContainText(longName);
			expect(await heading.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
				true
			);
			await modal.getByRole('button', { name: 'Cancel' }).click();
			await page.close();
		});

		test('shows a busy run and its actionable remedy', async ({ browser, world }) => {
			const { sourceName, sourceNumber, destinationName } = world;
			const page = await open(browser, `/issues/${sourceName}/${sourceNumber}`);
			await page.route('**/api/v1/issues/*/transfer?*', async (route) => {
				const response = await route.fetch();
				const preview = await response.json();
				await route.fulfill({
					response,
					json: {
						...preview,
						can_commit: false,
						preview_token: null,
						blockers: [
							{
								code: 'issue_busy',
								message: 'Run arun_busy is running; wait for it to finish or cancel it separately',
								run_id: 'arun_busy',
								run_status: 'running',
								remedy: 'tines runs show arun_busy'
							}
						]
					}
				});
			});
			const modal = page.getByRole('dialog');
			await clickToOpen(page.getByTestId('move-to-project'), modal);
			await modal.getByTestId('transfer-destination').selectOption({ label: destinationName });
			await modal.getByRole('button', { name: 'Review move' }).click();
			await expect(modal.getByTestId('transfer-blocker')).toContainText('arun_busy');
			await expect(modal.getByTestId('transfer-blocker')).toContainText(
				'tines runs show arun_busy'
			);
			await expect(modal.getByTestId('transfer-confirm')).toBeDisabled();
			await page.close();
		});

		test('shows retained pins and consequential routing beneath an automation-off headline', async ({
			browser,
			world
		}) => {
			const { sourceName, sourceNumber, destinationName } = world;
			const page = await open(browser, `/issues/${sourceName}/${sourceNumber}`);
			await page.route('**/api/v1/issues/*/transfer?*', async (route) => {
				const response = await route.fetch();
				const preview = await response.json();
				const before = {
					eligible: false,
					verdict: 'Automation is off.',
					checks: [
						{ name: 'automation_enabled', ok: false, detail: 'Automation is disabled.' },
						{
							name: 'routed',
							ok: false,
							detail: 'No routing rule matches this issue.',
							action: {
								label: 'Open routing settings',
								href: '/routing?scope=source',
								cli: 'tines routing set --project "source" --runner local'
							}
						}
					],
					pin: { runner_id: 'rnr_missing', runner_name: null, tier: 'premium' },
					matched_rule: null,
					runner_rule: { rule_id: 'rrl_runner', scope_label: 'destination runner rule' },
					tier_override: 'premium',
					ambiguous_rules: [{ rule_id: 'rrl_tie', scope_label: 'tied urgent rule' }],
					targets: [
						{
							runner_id: 'rnr_missing',
							runner_name: 'Unavailable runner',
							tier: 'premium',
							model: null,
							verdict: 'offline',
							detail: 'No recent heartbeat.'
						}
					],
					parked: true,
					attempt_count: 3,
					attempt_limit: 3,
					active_run: { id: 'arun_existing', runner_name: 'Unavailable runner', status: 'running' },
					queue_position: 2
				};
				const after = {
					...before,
					checks: [
						{
							name: 'routed',
							ok: false,
							detail: 'Destination needs a rule.',
							action: {
								label: 'Add destination rule',
								cli: 'tines routing set --project "destination" --runner local'
							}
						}
					]
				};
				await route.fulfill({
					response,
					json: {
						...preview,
						preserved: {
							...preview.preserved,
							pinned_runner_id: 'rnr_missing',
							pinned_tier: 'premium',
							attempt_count: 3,
							parked: true
						},
						routing: { before, after }
					}
				});
			});
			const modal = page.getByRole('dialog');
			await clickToOpen(page.getByTestId('move-to-project'), modal);
			await modal.getByTestId('transfer-destination').selectOption({ label: destinationName });
			await modal.getByRole('button', { name: 'Review move' }).click();
			const review = modal.getByTestId('transfer-review');
			await expect(review).toContainText('Runner pin: rnr_missing; tier pin: premium');
			await expect(review).toContainText('Automation is off.');
			await expect(review).toContainText('No routing rule matches this issue.');
			const remedy = review.getByRole('link', { name: 'Open routing settings' });
			await expect(remedy).toHaveAttribute('href', '/routing?scope=source');
			await expect(review).not.toContainText('tines routing set --project "source" --runner local');
			await expect(review).toContainText(
				'tines routing set --project "destination" --runner local'
			);
			await expect(review).toContainText('Runner source rule: destination runner rule');
			await expect(review).toContainText('Tier override: premium');
			await expect(review).toContainText('Tied rule: tied urgent rule');
			await expect(review).toContainText('Unavailable runner');
			await expect(review).toContainText('Active run: arun_existing');
			await expect(review).toContainText('Queue position: 2');
			await expect(review).toContainText('Attempts: 3/3; parked: yes');
			await page.close();
		});

		test('reviews, inspects and cancels without writing anything', async ({
			browser,
			request,
			world
		}, testInfo) => {
			const { sourceName, sourceNumber, destinationName, issueId, conflictIds } = world;
			const page = await open(browser, `/issues/${sourceName}/${sourceNumber}`);
			const modal = page.getByRole('dialog');
			await clickToOpen(page.getByTestId('move-to-project'), modal);

			await modal.getByTestId('transfer-destination').selectOption({ label: destinationName });
			const [previewResponse] = await Promise.all([
				page.waitForResponse(
					(response) =>
						response.request().method() === 'GET' && response.url().includes('/transfer?')
				),
				modal.getByRole('button', { name: 'Review move' }).click()
			]);
			const preview = (await previewResponse.json()) as IssueTransferPreview;
			const review = page.getByTestId('transfer-review');
			await expect(review).toBeVisible();
			expect(preview.context.before.conflicts).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						dir: 'retained-checkout',
						item_ids: expect.arrayContaining([conflictIds.retainedA, conflictIds.retainedB])
					}),
					expect.objectContaining({
						dir: 'source-checkout',
						item_ids: expect.arrayContaining([conflictIds.sourceA, conflictIds.sourceB])
					})
				])
			);
			expect(preview.context.after.conflicts).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						dir: 'retained-checkout',
						item_ids: expect.arrayContaining([conflictIds.retainedA, conflictIds.retainedB])
					}),
					expect.objectContaining({
						dir: 'destination-checkout',
						item_ids: expect.arrayContaining([conflictIds.destinationA, conflictIds.destinationB])
					})
				])
			);

			// The review names both addresses, the record it preserves, and the
			// guidance each side of the move.
			await expect(review).toContainText(`${sourceName}/${sourceNumber}`);
			await expect(review).toContainText(destinationName);
			await expect(review).toContainText('1 comments');
			await expect(review).toContainText(`source-only-${label}`);
			await expect(review).toContainText(`destination-only-${label}`);
			await expect(review).toContainText(`retained-prompt-${label}`);
			await expect(review).toContainText(`retained-skill-${label}`);
			await expect(review).toContainText('https://example.test/issue-override.git');
			await expect(review).toContainText('branch research; directory app');
			await expect(review).toContainText('https://example.test/source.git');
			await expect(review).toContainText('https://example.test/destination.git');

			const participantLine = (
				prefix: 'Before' | 'After',
				context: EffectiveContext,
				keys: string[]
			) => {
				const participants = keys
					.map((key) => conflictIds[key])
					.sort()
					.map((itemId) => {
						const repository = context.repos.find((repo) => repo.item_id === itemId);
						expect(repository, `effective repository ${itemId} is present`).toBeTruthy();
						return `${repository!.name} (${repository!.scope.label})`;
					});
				return `${prefix}: ${participants.join(', ')}`;
			};
			const conflictRow = (classification: string, directory: string) =>
				review
					.getByTestId('transfer-conflict-row')
					.filter({ hasText: `${classification} — ${directory}` });

			const retained = conflictRow('Retained', 'retained-checkout');
			await expect(retained).toHaveCount(1);
			await expect(
				retained.getByText(
					participantLine('Before', preview.context.before, ['retainedA', 'retainedB']),
					{ exact: true }
				)
			).toBeVisible();
			await expect(
				retained.getByText(
					participantLine('After', preview.context.after, ['retainedA', 'retainedB']),
					{ exact: true }
				)
			).toBeVisible();

			const resolved = conflictRow('Resolved', 'source-checkout');
			await expect(resolved).toHaveCount(1);
			await expect(
				resolved.getByText(
					participantLine('Before', preview.context.before, ['sourceA', 'sourceB']),
					{ exact: true }
				)
			).toBeVisible();
			await expect(resolved.getByText(/^After:/)).toHaveCount(0);

			const introduced = conflictRow('Introduced', 'destination-checkout');
			await expect(introduced).toHaveCount(1);
			await expect(
				introduced.getByText(
					participantLine('After', preview.context.after, ['destinationA', 'destinationB']),
					{ exact: true }
				)
			).toBeVisible();
			await expect(introduced.getByText(/^Before:/)).toHaveCount(0);
			expect(await modal.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
				true
			);
			expect(await review.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
				true
			);
			await testInfo.attach(`populated-transfer-review-${label}`, {
				body: await review.screenshot(),
				contentType: 'image/png'
			});

			// Each guidance item is inspectable in place: opening one shows the
			// scope it moves between rather than a bare name.
			const item = review.locator('details').filter({ hasText: `retained-prompt-${label}` });
			await item.locator('summary').click();
			await expect(item).toContainText('→');
			await expect(item).toContainText('Before and after');
			await expect(item).toContainText('Retained issue prompt body');
			const skill = review.locator('details').filter({ hasText: `retained-skill-${label}` });
			await skill.locator('summary').click();
			await expect(skill).toContainText('Retained skill instructions');
			await expect(skill).toContainText('Retained second file');

			await modal.getByRole('button', { name: 'Cancel' }).click();
			await expect(modal).toHaveCount(0);

			// A cancelled review allocates no number and records no event: the
			// issue is still at its old address.
			const api = apiClient(request, ALICE.apiKey);
			const still = await body<IssueDetail>(await api.get(`/api/v1/issues/${issueId}`));
			expect(still.project_name).toBe(sourceName);
			expect(still.number).toBe(sourceNumber);
			await page.close();
		});

		test('confirms the move and stays on the new canonical address', async ({
			browser,
			request,
			world
		}) => {
			const { sourceName, sourceId, sourceNumber, destinationName, issueId } = world;
			const api = apiClient(request, ALICE.apiKey);
			expect((await api.patch('/api/v1/preferences', { focused_project_id: sourceId })).ok()).toBe(
				true
			);
			const page = await open(browser, `/issues/${sourceName}/${sourceNumber}`);
			const modal = page.getByRole('dialog');
			await clickToOpen(page.getByTestId('move-to-project'), modal);
			await modal.getByTestId('transfer-destination').selectOption({ label: destinationName });
			await modal.getByRole('button', { name: 'Review move' }).click();
			await expect(page.getByTestId('transfer-review')).toBeVisible();
			const [transferResponse] = await Promise.all([
				page.waitForResponse(
					(response) =>
						response.request().method() === 'POST' &&
						response.url().endsWith(`/api/v1/issues/${issueId}/transfer`)
				),
				page.getByTestId('transfer-confirm').click()
			]);
			expect(transferResponse.status()).toBe(200);
			const receipt = await transferResponse.json();
			expect(receipt).toMatchObject({
				status: 'transferred',
				issue_id: issueId,
				old_ref: { ref: `${sourceName}/${sourceNumber}` },
				new_ref: { ref: `${destinationName}/2` },
				event_id: expect.any(String),
				issue_path: `/issues/${destinationName}/2`,
				preserved: expect.any(Object),
				context_changes: expect.any(Array),
				routing: expect.any(Object)
			});

			// The destination's number is its next one (its first is taken), and
			// the browser lands on that canonical URL without leaving the issue.
			await expect(page).toHaveURL(new RegExp(`/issues/${destinationName}/2$`));
			await expect(page.getByRole('status')).toContainText(
				`Moved ${sourceName}/${sourceNumber} to ${destinationName}/2`
			);
			await expect(page.getByRole('heading', { name: `${sourceName} traveller` })).toBeVisible();
			await expect(page.getByText('a comment that survives')).toBeVisible();
			await expect(
				page.getByRole('button', { name: `Project focus: ${sourceName}` })
			).toBeVisible();
			await expect(page.getByRole('button', { name: `Focus ${destinationName}` })).toBeVisible();

			// The record and the identity survive; only the address changed.
			const moved = await body<IssueDetail>(await api.get(`/api/v1/issues/${issueId}`));
			expect(moved.project_name).toBe(destinationName);
			expect(moved.number).toBe(2);
			expect(moved.id).toBe(issueId);
			const projects = await body<{ items: Project[] }>(await api.get('/api/v1/projects'));
			expect(projects.items.find((project) => project.id === sourceId)?.issue_count).toBe(0);
			expect(projects.items.find((project) => project.name === destinationName)?.issue_count).toBe(
				2
			);

			// The old address still reaches it, and the browser canonicalises.
			const alias = await body<IssueDetail>(
				await api.get(`/api/v1/projects/${sourceId}/issues/${sourceNumber}`)
			);
			expect(alias.id).toBe(issueId);
			await gotoHydrated(page, `/issues/${sourceName}/${sourceNumber}?keep=1#activity`);
			await expect(page).toHaveURL(new RegExp(`/issues/${destinationName}/2\\?keep=1#activity$`));

			// The issue's own project no longer offers itself as a destination.
			await clickToOpen(page.getByTestId('move-to-project'), modal);
			const options = await modal
				.getByTestId('transfer-destination')
				.locator('option')
				.allTextContents();
			expect(options).not.toContain(destinationName);
			expect(options).toContain(sourceName);
			await page.close();
		});

		test('real CLI human and JSON confirmations return the first successful D1 receipt', async ({
			request,
			world
		}) => {
			const { sourceName, sourceId, destinationName } = world;
			const api = apiClient(request, ALICE.apiKey);
			const humanIssue = await body<IssueDetail>(
				await api.post(`/api/v1/projects/${sourceId}/issues`, { title: `CLI human ${label}` })
			);
			const jsonIssue = await body<IssueDetail>(
				await api.post(`/api/v1/projects/${sourceId}/issues`, { title: `CLI JSON ${label}` })
			);
			const env = { ...process.env, TINES_API_KEY: ALICE.apiKey, TINES_API_URL: BASE_URL };
			const human = execFileSync(
				TSX,
				[
					CLI_ENTRY,
					'issues',
					'transfer',
					`${sourceName}/${humanIssue.number}`,
					'--project',
					destinationName,
					'--yes'
				],
				{ cwd: CLI_DIR, env, encoding: 'utf8' }
			);
			expect(human).toContain(`moved ${sourceName}/${humanIssue.number} to ${destinationName}/`);
			expect(human).toContain(`${sourceName}/${humanIssue.number} still resolves to this issue`);
			const json = JSON.parse(
				execFileSync(
					TSX,
					[
						CLI_ENTRY,
						'issues',
						'transfer',
						`${sourceName}/${jsonIssue.number}`,
						'--project',
						destinationName,
						'--yes',
						'--json'
					],
					{ cwd: CLI_DIR, env, encoding: 'utf8' }
				)
			);
			expect(json).toMatchObject({
				status: 'transferred',
				issue_id: jsonIssue.id,
				old_ref: { ref: `${sourceName}/${jsonIssue.number}` },
				new_ref: { project_name: destinationName },
				event_id: expect.any(String)
			});
			const canonical = await body<IssueDetail>(await api.get(`/api/v1/issues/${jsonIssue.id}`));
			expect(canonical.project_name).toBe(destinationName);
			expect(canonical.number).toBe(json.new_ref.number);
		});

		test('never offers an archived project, and refuses one archived mid-review', async ({
			browser,
			request,
			world
		}) => {
			const { sourceName, sourceId, destinationName, issueId } = world;
			// The issue now lives in the destination; its old source is the one
			// this test archives.
			const api = apiClient(request, ALICE.apiKey);
			const page = await open(browser, `/issues/${destinationName}/2`);
			const modal = page.getByRole('dialog');
			await clickToOpen(page.getByTestId('move-to-project'), modal);
			const chooser = modal.getByTestId('transfer-destination');
			await chooser.selectOption({ label: sourceName });
			await modal.getByRole('button', { name: 'Review move' }).click();
			await expect(page.getByTestId('transfer-review')).toBeVisible();

			// Archived under the open review: confirming is refused with the
			// server's own reason, and nothing moves.
			await api.post(`/api/v1/projects/${sourceId}/archive`, {});
			await page.getByTestId('transfer-confirm').click();
			await expect(modal.getByRole('alert').filter({ hasText: /archived/i })).toBeVisible();
			const still = await body<IssueDetail>(await api.get(`/api/v1/issues/${issueId}`));
			expect(still.project_name).toBe(destinationName);
			expect(still.number).toBe(2);

			// And an archived project is not offered as a destination at all.
			await modal.getByRole('button', { name: 'Cancel' }).click();
			await gotoHydrated(page, `/issues/${destinationName}/2`);
			await clickToOpen(page.getByTestId('move-to-project'), modal);
			expect(await chooser.locator('option').allTextContents()).not.toContain(sourceName);

			await api.post(`/api/v1/projects/${sourceId}/unarchive`, {});
			await page.close();
		});

		test('asks again when the guidance changes under a review', async ({
			browser,
			request,
			world,
			uniqueName
		}) => {
			const { sourceName, sourceId, destinationName, issueId } = world;
			const lateGuidanceName = uniqueName(`late-guidance-${label}`);
			const page = await open(browser, `/issues/${destinationName}/2`);
			const modal = page.getByRole('dialog');
			await clickToOpen(page.getByTestId('move-to-project'), modal);
			await modal.getByTestId('transfer-destination').selectOption({ label: sourceName });
			await modal.getByRole('button', { name: 'Review move' }).click();
			await expect(page.getByTestId('transfer-review')).toBeVisible();

			// Someone adds guidance at the destination after the review was read.
			const api = apiClient(request, ALICE.apiKey);
			const late = await body<{ id: string }>(
				await api.post('/api/v1/context', {
					kind: 'prompt',
					name: lateGuidanceName,
					project_id: sourceId,
					body: 'added after the review'
				})
			);

			await page.getByTestId('transfer-confirm').click();
			// Refused and refreshed, not reposted: the operator confirms the
			// guidance that is true now.
			await expect(page.getByTestId('transfer-stale')).toBeVisible();
			await expect(page.getByTestId('transfer-review')).toContainText(lateGuidanceName);
			const midway = await body<IssueDetail>(await api.get(`/api/v1/issues/${issueId}`));
			expect(midway.project_name).toBe(destinationName);

			// The refreshed review commits on a second, deliberate confirmation.
			await page.getByTestId('transfer-confirm').click();
			await expect(page).toHaveURL(new RegExp(`/issues/${sourceName}/\\d+$`));
			const moved = await body<IssueDetail>(await api.get(`/api/v1/issues/${issueId}`));
			expect(moved.project_name).toBe(sourceName);
			expect(moved.id).toBe(issueId);
			await api.delete(`/api/v1/context/${late.id}`);
			await page.close();
		});

		test('contains focus, closes on Escape and writes nothing', async ({
			browser,
			request,
			world
		}) => {
			const { issueId } = world;
			const api = apiClient(request, ALICE.apiKey);
			const before = await body<IssueDetail>(await api.get(`/api/v1/issues/${issueId}`));
			const page = await open(browser, `/issues/${before.project_name}/${before.number}`);
			const modal = page.getByRole('dialog');
			await clickToOpen(page.getByTestId('move-to-project'), modal);

			// Tab walks the dialog's own controls and never escapes to the page.
			for (let i = 0; i < 8; i++) {
				await page.keyboard.press('Tab');
				expect(await modal.evaluate((el) => el.contains(document.activeElement))).toBe(true);
			}
			await page.keyboard.press('Shift+Tab');
			await page.keyboard.press('Escape');
			await expect(modal).toHaveCount(0);

			// Escape is a cancellation: the address is untouched.
			const after = await body<IssueDetail>(await api.get(`/api/v1/issues/${issueId}`));
			expect(after.project_name).toBe(before.project_name);
			expect(after.number).toBe(before.number);
			await page.close();
		});

		test('recovers when the commit response is lost after the move', async ({
			browser,
			request,
			world
		}) => {
			const { issueId, sourceName, destinationName } = world;
			const api = apiClient(request, ALICE.apiKey);
			const before = await body<IssueDetail>(await api.get(`/api/v1/issues/${issueId}`));
			const target = before.project_name === sourceName ? destinationName : sourceName;
			const page = await open(browser, `/issues/${before.project_name}/${before.number}`);
			await page.route('**/api/v1/issues/*/transfer', async (route) => {
				if (route.request().method() !== 'POST') return route.continue();
				const response = await route.fetch();
				await response.body();
				await route.abort('failed');
			});
			const modal = page.getByRole('dialog');
			await clickToOpen(page.getByTestId('move-to-project'), modal);
			await modal.getByTestId('transfer-destination').selectOption({ label: target });
			await modal.getByRole('button', { name: 'Review move' }).click();
			await modal.getByTestId('transfer-confirm').click();
			await expect(modal.getByRole('alert')).toContainText('may have completed');
			await modal.getByRole('button', { name: 'Check current issue' }).click();
			const moved = await body<IssueDetail>(await api.get(`/api/v1/issues/${issueId}`));
			await expect(page).toHaveURL(
				new RegExp(`/issues/${encodeURIComponent(moved.project_name)}/${moved.number}$`)
			);
			await page.close();
		});
	});
}

suite('desktop', { width: 1440, height: 900 });
suite('phone', { width: 390, height: 844 });
