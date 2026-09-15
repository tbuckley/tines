import type {
	ContextItem,
	DeleteLabelResponse,
	DispatchExplainer,
	EffectiveContext,
	IssueDetail,
	Label,
	ListResponse,
	Project,
	RoutingRule,
	RoutingRuleWithWarnings,
	TinesEvent,
	WorkflowResponse
} from '@tines/shared';
import type { Route } from '@playwright/test';
import { expect, test as base } from './fixtures';
import { ALICE, RUNROW } from './constants.mjs';
import { apiClient, body, errorBody, gotoHydrated, resetFocus, signIn } from './helpers';

const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 900 };

type LabelsUiWorld = {
	projectName: string;
	bugName: string;
	p1Name: string;
	crowdNames: string[];
	wideName: string;
	labelledTitle: string;
	plainTitle: string;
	crowdedTitle: string;
	wideTitle: string;
	project: Project;
	labelled: IssueDetail;
	plain: IssueDetail;
	crowded: IssueDetail;
	bug: Label;
};

const labelsUiTest = base.extend<{}, { world: LabelsUiWorld }>({
	world: [
		async ({ apiFor, uniqueName }, use) => {
			const projectName = uniqueName('labels-ui');
			const bugName = uniqueName('bug-ui');
			const p1Name = uniqueName('p1-ui');
			const crowdNames = ['c1', 'c2', 'c3', 'c4', 'c5-a-really-long-label-name'].map((stem) =>
				uniqueName(stem)
			);
			// Wide glyphs keep this over the phone threshold on both macOS and Linux
			// while the 32-character cap still lets the whole chip fit on desktop.
			const wideName = uniqueName('WWWWW', { maxLength: 32 });
			const labelledTitle = uniqueName('Labelled', { maxLength: 100 });
			const plainTitle = uniqueName('Plain', { maxLength: 100 });
			const crowdedTitle = `${uniqueName('Crowded', { maxLength: 50 })} — runner daemon drops the log tail when a run is canceled`;
			const wideTitle = uniqueName('Wide', { maxLength: 100 });
			const api = apiFor(ALICE);
			const project = await body<Project>(
				await api.post('/api/v1/projects', { name: projectName })
			);
			const bug = await body<Label>(
				await api.post('/api/v1/labels', { name: bugName, color: 'red' })
			);
			await body<Label>(await api.post('/api/v1/labels', { name: p1Name, color: 'blue' }));
			const labelled = await body<IssueDetail>(
				await api.post(`/api/v1/projects/${project.id}/issues`, {
					title: labelledTitle,
					labels: [bugName]
				})
			);
			const plain = await body<IssueDetail>(
				await api.post(`/api/v1/projects/${project.id}/issues`, { title: plainTitle })
			);
			for (const name of crowdNames) {
				await body<Label>(await api.post('/api/v1/labels', { name, color: 'green' }));
			}
			const crowded = await body<IssueDetail>(
				await api.post(`/api/v1/projects/${project.id}/issues`, {
					title: crowdedTitle,
					labels: crowdNames
				})
			);
			await body<Label>(await api.post('/api/v1/labels', { name: wideName, color: 'orange' }));
			await body<IssueDetail>(
				await api.post(`/api/v1/projects/${project.id}/issues`, {
					title: wideTitle,
					labels: [wideName]
				})
			);
			await use({
				projectName,
				bugName,
				p1Name,
				crowdNames,
				wideName,
				labelledTitle,
				plainTitle,
				crowdedTitle,
				wideTitle,
				project,
				labelled,
				plain,
				crowded,
				bug
			});
		},
		{ scope: 'worker' }
	]
});

/**
 * Labels in the browser: the chip on a list row, the editable card on the
 * detail page, the filter bar, and the settings page. The API-level
 * behaviour (AND filtering, run-key rules) lives in api.spec.ts.
 */
labelsUiTest.describe.serial('issue labels UI', () => {
	labelsUiTest.use({ signedIn: ALICE });

	labelsUiTest.beforeEach(async ({ request }) => {
		// Specs share one user: a focus left behind would scope this one's lists.
		await resetFocus(request);
	});

	labelsUiTest('list rows carry chips and the filter narrows to them', async ({ page, world }) => {
		const { projectName, labelledTitle, plainTitle, bug, bugName } = world;
		await page.goto(`/issues?project=${encodeURIComponent(projectName)}`);
		await expect(page.getByRole('link', { name: labelledTitle })).toBeVisible();
		await expect(page.getByText(bugName, { exact: true }).first()).toBeVisible();

		// The filter carries ids, so the URL survives a rename.
		await page.goto(`/issues?project=${encodeURIComponent(projectName)}&label=${bug.id}`);
		await expect(page.getByText(labelledTitle)).toBeVisible();
		await expect(page.getByText(plainTitle)).toHaveCount(0);
		// The active filter shows as a chip beside the Filter button, and the
		// button counts it.
		await expect(
			page.getByRole('button', { name: `Remove filter label: ${bugName}` })
		).toBeVisible();
		await expect(page.getByRole('button', { name: 'Filter, 1 active' })).toBeVisible();
	});

	labelsUiTest('the detail card adds and removes a label', async ({ page, world }) => {
		const { projectName, plain, p1Name } = world;
		await gotoHydrated(page, `/issues/${encodeURIComponent(projectName)}/${plain.number}`);
		const card = page.locator('section', { has: page.getByRole('heading', { name: 'Labels' }) });
		await expect(card.getByText('No labels.')).toBeVisible();

		await expect(async () => {
			await card.getByRole('button', { name: 'Edit' }).click();
			await expect(page.getByRole('button', { name: p1Name })).toBeVisible({ timeout: 2000 });
		}).toPass({ timeout: 15_000 });
		// The filter box caps at the API's own limit, so a too-long name is
		// never offered for creation and never costs a round trip.
		await expect(page.getByLabel('Filter labels')).toHaveAttribute('maxlength', '50');
		await page.getByRole('button', { name: p1Name }).click();
		await expect(card.getByText(p1Name)).toBeVisible();

		// Survives a reload: the add really reached the server.
		await page.reload();
		await expect(card.getByText(p1Name)).toBeVisible();

		await card.getByRole('button', { name: `Remove label ${p1Name}` }).click();
		await expect(card.getByText('No labels.')).toBeVisible();
		await page.reload();
		await expect(card.getByText('No labels.')).toBeVisible();
	});

	labelsUiTest(
		'the settings page lists labels with their usage and renames one',
		async ({ page, world }) => {
			const { projectName, labelled, bug, bugName } = world;
			await gotoHydrated(page, '/settings/labels');
			const rename = `${bugName}-renamed`;
			const row = page.locator('li', { has: page.getByLabel(`Rename ${bugName}`) });
			await expect(row.getByRole('link', { name: '1 issue' })).toBeVisible();
			await expect(
				page.getByText('Changes save automatically when you leave a field.')
			).toBeVisible();

			let releaseRequest!: () => void;
			const requestGate = new Promise<void>((resolve) => (releaseRequest = resolve));
			const updateEndpoint = `**/api/v1/labels/${bug.id}`;
			await page.route(updateEndpoint, async (route) => {
				await requestGate;
				await route.continue();
			});

			// A `change` dispatched before hydration finishes is lost — the input is
			// server-rendered, its handler is not — so the rename is retried. But
			// `fill` only produces a `change` when the value actually moves, and a
			// swallowed attempt leaves the field already reading `rename`, so a naive
			// retry is a silent no-op forever. Blanking the field and blurring first
			// makes every attempt a real change.
			await expect(async () => {
				const field = page.getByLabel(`Rename ${bugName}`);
				await field.fill('');
				await field.blur();
				await field.fill(rename);
				await field.blur();
				await expect(row.getByText('Saving…')).toBeVisible({ timeout: 3000 });
			}).toPass({ timeout: 15_000 });
			releaseRequest();
			await expect(page.getByLabel(`Rename ${rename}`)).toBeVisible();
			await expect(page.getByText('Saved', { exact: true })).toBeVisible();
			await expect(page.getByText('Saved', { exact: true }).locator('svg')).toBeVisible();

			// A later edit replaces the acknowledgement, and a failed request can
			// never inherit the earlier success state.
			await page.unroute(updateEndpoint);
			await page.route(updateEndpoint, (route) =>
				route.fulfill({
					status: 503,
					contentType: 'application/json',
					body: JSON.stringify({ error: { code: 'unavailable', message: 'Try again later' } })
				})
			);
			const renamedRow = page.locator('li', { has: page.getByLabel(`Rename ${rename}`) });
			const description = renamedRow.getByLabel(`Description for ${rename}`);
			await description.fill('will not save');
			// The prior acknowledgement must not describe a value that has only been
			// typed locally, including an invalid value that will never be requested.
			await expect(renamedRow.getByText('Saved', { exact: true })).toHaveCount(0);
			await description.blur();
			await expect(renamedRow.getByText('Not saved', { exact: false })).toHaveAttribute(
				'title',
				'Try again later'
			);
			await expect(renamedRow.getByText('Saved', { exact: true })).toHaveCount(0);

			// Completion order, rather than request order, must not let a stale
			// response replace the newest request's acknowledgement.
			await page.unroute(updateEndpoint);
			const pending = new Map<string, Route>();
			await page.route(updateEndpoint, (route) => {
				const value = route.request().postDataJSON().description as string;
				pending.set(value, route);
			});
			const startDescriptionSave = async (value: string) => {
				await description.fill(value);
				await description.blur();
				await expect.poll(() => pending.has(value)).toBe(true);
			};
			const finish = async (value: string, status: 200 | 503) => {
				const invalidated =
					status === 200
						? page.waitForResponse(
								(candidate) =>
									candidate.request().method() === 'GET' &&
									new URL(candidate.url()).pathname.endsWith('/settings/labels/__data.json')
							)
						: null;
				const response = page.waitForResponse(
					(candidate) =>
						candidate.url().endsWith(`/api/v1/labels/${bug.id}`) &&
						candidate.request().postDataJSON().description === value
				);
				await pending.get(value)!.fulfill(
					status === 200
						? { status, json: { ...bug, name: rename, description: value } }
						: {
								status,
								contentType: 'application/json',
								body: JSON.stringify({
									error: { code: 'unavailable', message: 'Try again later' }
								})
							}
				);
				await response;
				if (invalidated) await invalidated;
				await page.evaluate(
					() =>
						new Promise<void>((resolve) =>
							requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
						)
				);
			};

			await startDescriptionSave('older success');
			await startDescriptionSave('newer failure');
			await finish('newer failure', 503);
			await expect(renamedRow.getByText('Not saved', { exact: false })).toBeVisible();
			await finish('older success', 200);
			await expect(renamedRow.getByText('Not saved', { exact: false })).toBeVisible();
			await expect(renamedRow.getByText('Saved', { exact: true })).toHaveCount(0);

			await startDescriptionSave('older failure');
			await startDescriptionSave('newer success');
			await finish('newer success', 200);
			await expect(renamedRow.getByText('Saved', { exact: true })).toBeVisible();
			await finish('older failure', 503);
			await expect(renamedRow.getByText('Saved', { exact: true })).toBeVisible();
			await expect(renamedRow.getByText('Not saved', { exact: false })).toHaveCount(0);

			// The rename reaches the chips that render from the same row.
			await page.goto(`/issues/${encodeURIComponent(projectName)}/${labelled.number}`);
			await expect(page.getByText(rename).first()).toBeVisible();
		}
	);

	labelsUiTest(
		'a row shows its labels whole or as a count, costing no height',
		async ({ page, world }) => {
			const { projectName, crowded, crowdNames, wideName, crowdedTitle, plainTitle, wideTitle } =
				world;
			const list = `/issues?project=${encodeURIComponent(projectName)}`;
			const crowdedRow = page.getByRole('link', { name: crowdedTitle });
			// One-line titles with no label and with one: the yardsticks for "labels
			// cost no height".
			const plainRow = page.getByRole('link', { name: plainTitle });
			const wideRow = page.getByRole('link', { name: wideTitle });
			const strip = crowdedRow.getByTestId('label-strip');
			// The measurement copy carries the same names, so pin what renders.
			const visibleChips = (s: typeof strip) =>
				s.locator('> div:not([aria-hidden]) > span:visible');

			await page.setViewportSize(PHONE);
			await page.goto(list);
			await expect(crowdedRow).toBeVisible();
			// Five chips never fit a phone's metadata line, so the set is one chip
			// carrying the count — never a subset, never a name cut mid-word.
			// A string, not a regex: Playwright normalizes whitespace for the former only.
			const count = visibleChips(strip).filter({ hasText: '5 labels' });
			await expect(count).toBeVisible();
			await expect(visibleChips(strip)).toHaveCount(1);
			// The names behind the count stay reachable.
			await expect(count).toHaveAttribute('title', new RegExp(crowdNames.at(-1)!));
			// Nothing spills: the chip ends inside the strip.
			const stripRect = (await strip.boundingBox())!;
			const chipRect = (await count.boundingBox())!;
			expect(chipRect.x + chipRect.width).toBeLessThanOrEqual(stripRect.x + stripRect.width + 1);
			expect(chipRect.x).toBeGreaterThanOrEqual(stripRect.x - 1);

			// One line, whatever it holds: the strip is a single chip tall...
			expect(stripRect.height).toBeLessThan(24);

			// ...and it rides the metadata line the state is already on, starting
			// after it — read in one layout pass, so the boxes are the same moment
			// (Tines/123).
			const line = await crowdedRow.evaluate((row) => {
				const box = (el: Element | null) => {
					const r = el!.getBoundingClientRect();
					return { x: r.x, right: r.right, top: r.top, bottom: r.bottom };
				};
				return {
					row: box(row),
					state: box(row.querySelector('[style*="issue-state"]')),
					strip: box(row.querySelector('[data-testid="label-strip"]')),
					title: box(row.querySelector('[style*="issue-title"]'))
				};
			});
			expect(line.strip.x).toBeGreaterThanOrEqual(line.state.right);
			// Same line as the state: their vertical spans overlap.
			expect(line.strip.top).toBeLessThan(line.state.bottom);
			expect(line.strip.bottom).toBeGreaterThan(line.state.top);
			// Below the title, not beside it.
			expect(line.strip.top).toBeGreaterThanOrEqual(line.title.bottom);
			// That line is not indented under the title: it gets the row's full
			// width.
			expect(line.state.x - line.row.x).toBeLessThan(24);

			// The number renders once.
			const number = (row: typeof crowdedRow) => row.locator(`span:text-is("#${crowded.number}")`);
			await expect(number(crowdedRow).locator('visible=true')).toHaveCount(1);

			// A single label too wide for the line is the count too ("1 label"),
			// not a clipped chip — and it costs the row nothing: same height as
			// the unlabelled row beside it.
			await expect(visibleChips(wideRow.getByTestId('label-strip'))).toHaveText(['1 label']);
			const wideBox = await wideRow.boundingBox();
			const plainBox = await plainRow.boundingBox();
			expect(Math.abs(wideBox!.height - plainBox!.height)).toBeLessThan(1);
			// Two title lines, one metadata line: never more.
			expect((await crowdedRow.boundingBox())!.height).toBeLessThan(90);

			// Wider viewport: the strip stays, and the wide name now has room, so
			// it shows whole — a dot chip whose text is not clipped.
			await page.setViewportSize(DESKTOP);
			await expect(strip).toBeVisible();
			await expect(number(crowdedRow).locator('visible=true')).toHaveCount(1);
			const wideChip = wideRow.locator(`span:visible`, { hasText: wideName }).last();
			await expect(wideChip).toBeVisible();
			expect(await wideChip.evaluate((e) => e.scrollWidth - e.clientWidth)).toBeLessThanOrEqual(1);
			// Whole or counted, never cut: every visible chip in the crowded row
			// ends inside the strip, and labels take only what the title leaves.
			const chips = visibleChips(strip);
			const shown = await chips.count();
			expect(shown === crowdNames.length || shown === 1).toBe(true);
			const desktopStrip = (await strip.boundingBox())!;
			for (const chip of await chips.all()) {
				const b = (await chip.boundingBox())!;
				expect(b.x + b.width).toBeLessThanOrEqual(desktopStrip.x + desktopStrip.width + 1);
				expect(await chip.evaluate((e) => e.scrollWidth - e.clientWidth)).toBeLessThanOrEqual(1);
			}
			const titleText = crowdedRow.locator('[style*="issue-title"]');
			const titleCell = (await titleText.locator('..').boundingBox())!;
			expect(titleCell.width).toBeGreaterThanOrEqual((await titleText.boundingBox())!.width - 1);
			// This title fits the row, so it is not truncated at all: five labels
			// gave way to a count before the title lost a character.
			expect(await titleText.evaluate((e) => e.scrollWidth - e.clientWidth)).toBeLessThanOrEqual(1);
			// A labelled row costs no height at this width either — one 40px line,
			// like the plain row.
			const crowdedDesktopBox = await crowdedRow.boundingBox();
			const plainDesktopBox = await plainRow.boundingBox();
			expect(Math.abs(crowdedDesktopBox!.height - plainDesktopBox!.height)).toBeLessThan(1);

			// Nothing is lost — the detail page still shows every label.
			await page.setViewportSize(PHONE);
			await page.goto(`/issues/${encodeURIComponent(projectName)}/${crowded.number}`);
			for (const name of crowdNames) {
				await expect(page.getByText(name, { exact: true }).first()).toBeVisible();
			}
		}
	);
});

/**
 * Label as the fourth scope dimension (Tines/168): a label-scoped context
 * item reaches only the issues carrying the label, a label-scoped routing
 * rule routes them, two label rules that tie fail closed, run keys may not
 * touch a label a rule routes on, and deleting such a label is refused
 * before it is forced.
 *
 * Here rather than in `context.spec.ts` because every case needs a label,
 * and the two browser cases at the end read the same fixtures.
 */
const SKILL = 'component-testing';
type LabelScopeWorld = {
	projectName: string;
	docsName: string;
	secName: string;
	freeName: string;
	project: Project;
	docs: Label;
	sec: Label;
	activeStateId: string;
	labelled: IssueDetail;
	plainIssue: IssueDetail;
	projectSkillId: string;
	labelSkillId: string;
	docsRuleId?: string;
};

const scopeTest = base.extend<{}, { world: LabelScopeWorld }>({
	world: [
		async ({ apiFor, uniqueName, workerRequest }, use) => {
			const projectName = uniqueName('lscope');
			const docsName = uniqueName('lscope-docs');
			const secName = uniqueName('lscope-sec');
			const freeName = uniqueName('lscope-free');
			const api = apiFor(ALICE);
			await resetFocus(workerRequest);
			// Its own workflow with an active initial state: a routing rule's scope
			// must be active at authoring time, so the default workflow's category
			// cannot be left to chance.
			const workflow = await body<WorkflowResponse>(
				await api.post('/api/v1/workflows', {
					name: uniqueName('lscope-flow'),
					initial_state: 'Working',
					states: [
						{ name: 'Working', category: 'active' },
						{ name: 'Done', category: 'done' }
					],
					transitions: [{ name: 'finish', from: 'Working', to: 'Done' }]
				})
			);
			const activeStateId = workflow.states.find((s) => s.name === 'Working')!.id;
			const project = await body<Project>(
				await api.post('/api/v1/projects', {
					name: projectName,
					default_workflow_id: workflow.id
				})
			);
			const docs = await body<Label>(
				await api.post('/api/v1/labels', { name: docsName, color: 'violet' })
			);
			const sec = await body<Label>(
				await api.post('/api/v1/labels', { name: secName, color: 'amber' })
			);
			await body<Label>(await api.post('/api/v1/labels', { name: freeName, color: 'slate' }));

			const labelled = await body<IssueDetail>(
				await api.post(`/api/v1/projects/${project.id}/issues`, {
					title: uniqueName('Labelled', { maxLength: 100 }),
					labels: [docsName]
				})
			);
			const plainIssue = await body<IssueDetail>(
				await api.post(`/api/v1/projects/${project.id}/issues`, {
					title: uniqueName('Unlabelled', { maxLength: 100 })
				})
			);

			// The same name at two scopes: the label-scoped one is the more
			// specific, so it must override rather than sit beside it.
			const projectSkillId = (
				await body<ContextItem>(
					await api.post('/api/v1/context', {
						kind: 'skill',
						name: SKILL,
						project_id: project.id,
						files: [{ path: 'SKILL.md', content: 'project-wide' }]
					})
				)
			).id;
			const labelSkill = await body<ContextItem>(
				await api.post('/api/v1/context', {
					kind: 'skill',
					name: SKILL,
					project_id: project.id,
					label_id: docs.id,
					files: [{ path: 'SKILL.md', content: 'for labelled work' }]
				})
			);
			const labelSkillId = labelSkill.id;
			expect(labelSkill.scope.label).toBe(`project ${projectName} · label ${docsName}`);
			expect(labelSkill.scope.label_name).toBe(docsName);
			await use({
				projectName,
				docsName,
				secName,
				freeName,
				project,
				docs,
				sec,
				activeStateId,
				labelled,
				plainIssue,
				projectSkillId,
				labelSkillId
			});
		},
		{ scope: 'worker' }
	]
});

scopeTest.describe.serial('label as a scope dimension', () => {
	scopeTest(
		'reaches the labelled issue only, overriding the project skill by name',
		async ({ request, world }) => {
			const { labelled, plainIssue, projectSkillId, labelSkillId } = world;
			const api = apiClient(request, ALICE.apiKey);
			const withLabel = await body<EffectiveContext>(
				await api.get(`/api/v1/issues/${labelled.id}/context`)
			);
			expect(withLabel.skills.map((s) => s.item_id)).toEqual([labelSkillId]);
			// The project-wide one lost by name, and the bundle says so.
			expect(withLabel.overridden).toContainEqual(
				expect.objectContaining({ kind: 'skill', name: SKILL, item_id: projectSkillId })
			);

			// Same project, no label: the project-wide skill, unchallenged.
			const without = await body<EffectiveContext>(
				await api.get(`/api/v1/issues/${plainIssue.id}/context`)
			);
			expect(without.skills.map((s) => s.item_id)).toEqual([projectSkillId]);
			expect(without.overridden.filter((o) => o.name === SKILL)).toEqual([]);
		}
	);

	scopeTest(
		'labelling and unlabelling an issue changes what it is given',
		async ({ request, world }) => {
			const { plainIssue, docsName, labelSkillId, projectSkillId } = world;
			const api = apiClient(request, ALICE.apiKey);
			await body(await api.post(`/api/v1/issues/${plainIssue.id}/labels`, { labels: [docsName] }));
			let ctx = await body<EffectiveContext>(
				await api.get(`/api/v1/issues/${plainIssue.id}/context`)
			);
			expect(ctx.skills.map((s) => s.item_id)).toEqual([labelSkillId]);

			const removed = await api.delete(
				`/api/v1/issues/${plainIssue.id}/labels/${encodeURIComponent(docsName)}`
			);
			expect(removed.status()).toBe(204);
			ctx = await body<EffectiveContext>(await api.get(`/api/v1/issues/${plainIssue.id}/context`));
			expect(ctx.skills.map((s) => s.item_id)).toEqual([projectSkillId]);
		}
	);

	scopeTest('lists context items by label, by id and by name', async ({ request, world }) => {
		const { docs, docsName, labelSkillId } = world;
		const api = apiClient(request, ALICE.apiKey);
		for (const ref of [docs.id, docsName]) {
			const { items } = await body<ListResponse<ContextItem>>(
				await api.get(`/api/v1/context?label=${encodeURIComponent(ref)}`)
			);
			expect(
				items.map((i) => i.id),
				`label=${ref}`
			).toEqual([labelSkillId]);
		}
	});

	scopeTest(
		'a label-scoped rule routes the labelled issue, and the explainer names it',
		async ({ request, world }) => {
			const { project, projectName, docs, docsName, labelled, plainIssue } = world;
			const api = apiClient(request, ALICE.apiKey);
			// Scoped to this project too, so it can never grab another spec's work
			// once runner.spec.ts arms the supervisor later in the run.
			const rule = await body<RoutingRuleWithWarnings>(
				await api.post('/api/v1/routing-rules', {
					project_id: project.id,
					label_id: docs.id,
					targets: [{ runner_id: RUNROW.runnerId }]
				})
			);
			world.docsRuleId = rule.id;
			expect(rule.scope.label).toBe(`project ${projectName} · label ${docsName}`);
			expect(rule.warnings).toEqual([]);

			const { items } = await body<ListResponse<RoutingRule>>(
				await api.get('/api/v1/routing-rules')
			);
			expect(items.find((r) => r.id === world.docsRuleId)?.scope.label_name).toBe(docsName);

			const explained = await body<DispatchExplainer>(
				await api.get(`/api/v1/issues/${labelled.id}/dispatch`)
			);
			expect(explained.matched_rule?.rule_id).toBe(world.docsRuleId);
			expect(explained.matched_rule?.scope_label).toBe(
				`project ${projectName} · label ${docsName}`
			);
			expect(explained.ambiguous_rules).toEqual([]);
			expect(explained.checks.find((c) => c.name === 'routed')?.ok).toBe(true);

			// The unlabelled issue in the same project matches nothing: the rule
			// really turns on the label, not on the project half of its scope.
			const unmatched = await body<DispatchExplainer>(
				await api.get(`/api/v1/issues/${plainIssue.id}/dispatch`)
			);
			expect(unmatched.matched_rule).toBeNull();
			expect(unmatched.checks.find((c) => c.name === 'routed')?.ok).toBe(false);
		}
	);

	scopeTest(
		'two label rules at equal specificity warn on save and then fail closed',
		async ({ request, world }) => {
			const { project, docs, sec, secName, labelled, activeStateId } = world;
			const docsRuleId = world.docsRuleId!;
			const api = apiClient(request, ALICE.apiKey);
			await body(await api.post(`/api/v1/issues/${labelled.id}/labels`, { labels: [secName] }));

			const rival = await body<RoutingRuleWithWarnings>(
				await api.post('/api/v1/routing-rules', {
					project_id: project.id,
					label_id: sec.id,
					targets: [{ runner_id: RUNROW.runnerId }]
				})
			);
			// Authoring time: saving the second rule says the two can tie. Only
			// labels can produce this — an issue carries a set of them.
			expect(rival.warnings).toContainEqual(
				expect.objectContaining({ kind: 'ambiguous', rule_id: docsRuleId })
			);

			const explained = await body<DispatchExplainer>(
				await api.get(`/api/v1/issues/${labelled.id}/dispatch`)
			);
			// Fail closed: no winner is invented, both candidates are named, and
			// the issue does not dispatch until one rule is made more specific.
			expect(explained.matched_rule).toBeNull();
			expect(explained.ambiguous_rules.map((r) => r.rule_id).sort()).toEqual(
				[docsRuleId, rival.id].sort()
			);
			const routed = explained.checks.find((c) => c.name === 'routed')!;
			expect(routed.ok).toBe(false);
			expect(routed.detail).toContain('neither is more specific');
			expect(explained.eligible).toBe(false);
			// Not the verdict line: automation is off in the seeded world, and that
			// reason outranks the tie. The tie's own wording is pinned in
			// `explain.test.ts`, where the supervisor can be armed safely.

			// Adding a dimension breaks the tie, rather than needing a delete.
			await body<RoutingRuleWithWarnings>(
				await api.patch(`/api/v1/routing-rules/${rival.id}`, { workflow_state_id: activeStateId })
			);
			const broken = await body<DispatchExplainer>(
				await api.get(`/api/v1/issues/${labelled.id}/dispatch`)
			);
			expect(broken.matched_rule?.rule_id).toBe(rival.id);
			expect(broken.ambiguous_rules).toEqual([]);

			await api.delete(`/api/v1/routing-rules/${rival.id}`);
			expect((await api.delete(`/api/v1/issues/${labelled.id}/labels/${sec.id}`)).status()).toBe(
				204
			);
		}
	);

	scopeTest(
		'the Routing list reads top-down: most specific first, with tie and shadow pills',
		async ({ page, context, request, world }) => {
			const { project, projectName, docs, docsName, sec, secName } = world;
			const api = apiClient(request, ALICE.apiKey);
			await resetFocus(request);
			// Re-form the tie the previous test broke, and add a bare project rule
			// that both label rules outrank — three overlapping scopes, created in
			// an order that is neither specificity nor alphabetical.
			const rival = await body<RoutingRuleWithWarnings>(
				await api.post('/api/v1/routing-rules', {
					project_id: project.id,
					label_id: sec.id,
					targets: [{ runner_id: RUNROW.runnerId }]
				})
			);
			const broad = await body<RoutingRuleWithWarnings>(
				await api.post('/api/v1/routing-rules', {
					project_id: project.id,
					targets: [{ runner_id: RUNROW.runnerId }]
				})
			);

			await signIn(context, ALICE.sessionToken);
			await page.setViewportSize(DESKTOP);
			await page.goto('/agents');
			// The precedence rule, on the page rather than one click away inside
			// the Add-rule modal. Matched on this sentence's own tail: the modal's
			// longer paragraph opens with the same clause, and `getByText` does
			// not normalise the newline prettier puts mid-sentence.
			await expect(page.getByText('Listed most specific first.')).toBeVisible();

			// This spec's three rules, among whatever other rules the account has.
			const rows = page
				.getByRole('list', { name: 'Routing rules' })
				.locator('li')
				.filter({ hasText: projectName });
			await expect(rows).toHaveCount(3);
			// Read the order off each row's own scope chip, never its text: the
			// tie pill *names the other rule's label*, so a text match would count
			// the `sec` row as a `docs` one.
			const scopeChip = (labelName: string) => page.locator(`[title="label ${labelName}"]`);
			const order = await rows.evaluateAll((lis) =>
				lis.map(
					(li) => li.querySelector('span[title^="label "]')?.getAttribute('title') ?? 'no label'
				)
			);
			// Most specific first: both label rules (rank 6) above the bare
			// project rule (rank 2), the two label rules tie-broken by scope label.
			expect(order).toEqual([`label ${docsName}`, `label ${secName}`, 'no label']);

			// The tie is stated on both rows that cause it — an issue carrying
			// both labels dispatches nowhere, and until now nothing on this page
			// said so.
			await expect(
				rows
					.filter({ has: scopeChip(docsName) })
					.getByText(`ties with project ${projectName} · label ${secName}`)
			).toBeVisible();
			await expect(
				rows
					.filter({ has: scopeChip(secName) })
					.getByText(`ties with project ${projectName} · label ${docsName}`)
			).toBeVisible();
			// The rule both of them outrank says so once, with the count; the two
			// full sentences are the tooltip.
			const broadRow = rows.filter({ hasNot: page.locator('[title^="label "]') });
			const shadowPill = broadRow.getByText('lower priority than 2 rules');
			await expect(shadowPill).toBeVisible();
			await expect(shadowPill).toHaveAttribute('title', /has higher priority/);
			// ...and no row claims the redundant other direction.
			await expect(page.getByText(/takes precedence over/)).toHaveCount(0);

			for (const id of [rival.id, broad.id]) await api.delete(`/api/v1/routing-rules/${id}`);
		}
	);

	scopeTest(
		'a run key may not apply or remove a label a routing rule is scoped to',
		async ({ request, world }) => {
			const { plainIssue, docsName, freeName, docs } = world;
			const runKey = apiClient(request, RUNROW.runKey);
			const alice = apiClient(request, ALICE.apiKey);
			const labelsOn = async (issueId: string) =>
				(await body<IssueDetail>(await alice.get(`/api/v1/issues/${issueId}`))).labels.map(
					(l) => l.name
				);

			const refused = await runKey.post(`/api/v1/issues/${plainIssue.id}/labels`, {
				labels: [docsName]
			});
			expect(refused.status()).toBe(403);
			const { error } = await errorBody(refused);
			expect(error.code).toBe('run_key_forbidden');
			expect(error.details?.reason).toBe('routing_label');
			expect(error.details?.labels).toEqual([docsName]);
			expect(error.message).toContain('a label a routing rule is scoped to');
			// Refused *before* the write: the issue is untouched.
			expect(await labelsOn(plainIssue.id)).toEqual([]);

			// A label no rule routes on stays the run key's to apply — the launch
			// prompt tells agents to classify their own work.
			await body(
				await runKey.post(`/api/v1/issues/${plainIssue.id}/labels`, { labels: [freeName] })
			);
			expect(await labelsOn(plainIssue.id)).toEqual([freeName]);
			expect(
				(
					await runKey.delete(
						`/api/v1/issues/${plainIssue.id}/labels/${encodeURIComponent(freeName)}`
					)
				).status()
			).toBe(204);

			// Removal is fenced the same way, and equally before the write.
			await body(
				await alice.post(`/api/v1/issues/${plainIssue.id}/labels`, { labels: [docsName] })
			);
			const unRefused = await runKey.delete(
				`/api/v1/issues/${plainIssue.id}/labels/${encodeURIComponent(docsName)}`
			);
			expect(unRefused.status()).toBe(403);
			expect((await errorBody(unRefused)).error.details?.reason).toBe('routing_label');
			expect(await labelsOn(plainIssue.id)).toEqual([docsName]);
			// A human is unaffected by any of it.
			expect(
				(await alice.delete(`/api/v1/issues/${plainIssue.id}/labels/${docs.id}`)).status()
			).toBe(204);
		}
	);

	scopeTest('the labels page counts what a label reaches', async ({ page, context, world }) => {
		const { docs, docsName } = world;
		await signIn(context, ALICE.sessionToken);
		await page.goto('/labels');
		const row = page.locator('div.divide-y > div').filter({ hasText: docsName });
		// One issue carries it, one skill and one rule are scoped to it — the
		// three counts `listLabels` computes, each linking to what it counts.
		await expect(row.getByRole('link', { name: '1 issue' })).toBeVisible();
		await expect(row.getByRole('link', { name: '1 context item' })).toHaveAttribute(
			'href',
			`/context?label=${docs.id}`
		);
		await expect(row.getByRole('link', { name: '1 routing rule' })).toBeVisible();
	});

	scopeTest(
		'the item editor saves a label scope, and the list filters to it',
		async ({ page, context, world, uniqueName }) => {
			const { docs, docsName } = world;
			await signIn(context, ALICE.sessionToken);
			// Unfiltered: this page passes the editor no scope defaults, so the
			// label select is the only dimension the new item gets.
			await gotoHydrated(page, '/context');
			const name = uniqueName('editor-scoped');
			const labelSelect = page.getByLabel('Only on issues labelled');

			// The select is fed by a lazy fetch, and a click landing before
			// hydration is lost — so retry the open until the options arrive.
			await expect(async () => {
				await page.getByRole('button', { name: 'New item' }).click();
				await expect(labelSelect).toBeVisible({ timeout: 2000 });
				await labelSelect.selectOption({ label: docsName }, { timeout: 2000 });
			}).toPass({ timeout: 15_000 });
			await page.getByLabel('Name', { exact: true }).fill(name);
			await page.getByLabel('Body (Markdown)').fill('Only for labelled work.');
			await page.getByRole('button', { name: 'Create' }).click();

			// The saved scope shows as the label's own coloured chip. `:not([inert])`
			// because `ContextItemList`'s rows carry `transition:slide`, and the
			// `label=` swap below removes rows — see `e2e/README.md`.
			const row = page.locator('li:not([inert])').filter({ hasText: name });
			await expect(row.getByTitle(`label ${docsName}`)).toBeVisible();
			// ...and the `label=` filter narrows the list to what carries it: the
			// new item and the label-scoped skill — one row for that name, not the
			// two same-named skills the unfiltered list holds.
			await page.goto(`/context?label=${docs.id}`);
			await expect(page.locator('li:not([inert])').filter({ hasText: name })).toBeVisible();
			await expect(page.locator('li:not([inert])').filter({ hasText: SKILL })).toHaveCount(1);
		}
	);

	scopeTest(
		'deleting the label is refused while it scopes work, then force-cascades',
		async ({ request, world }) => {
			const { docs, docsName, labelled, projectSkillId, labelSkillId } = world;
			const docsRuleId = world.docsRuleId!;
			const api = apiClient(request, ALICE.apiKey);
			const refused = await api.delete(`/api/v1/labels/${docs.id}`);
			expect(refused.status()).toBe(422);
			const { error } = await errorBody(refused);
			expect(error.code).toBe('label_in_use');
			expect(error.message).toContain('rules are deleted, not broadened');
			expect(error.details?.context_items).toContainEqual(
				expect.objectContaining({ kind: 'skill', name: SKILL, id: labelSkillId })
			);
			expect(error.details?.routing_rules).toContainEqual(
				expect.objectContaining({ id: docsRuleId })
			);

			const forced = await body<DeleteLabelResponse>(
				await api.delete(`/api/v1/labels/${docs.id}`, { force: true })
			);
			expect(forced.context_items_deleted.map((i) => i.id)).toContain(labelSkillId);
			expect(forced.routing_rules_deleted.map((r) => r.id)).toEqual([docsRuleId]);
			expect(forced.issue_count).toBe(1);

			// The rule is gone, not broadened to `project X` — broadening would
			// have quietly routed every issue in the project.
			const { items: rules } = await body<ListResponse<RoutingRule>>(
				await api.get('/api/v1/routing-rules')
			);
			expect(rules.some((r) => r.id === docsRuleId)).toBe(false);
			// ...and the project-wide skill is untouched, so the once-labelled
			// issue falls back to it.
			const ctx = await body<EffectiveContext>(
				await api.get(`/api/v1/issues/${labelled.id}/context`)
			);
			expect(ctx.skills.map((s) => s.item_id)).toEqual([projectSkillId]);

			const events = await body<ListResponse<TinesEvent>>(
				await api.get('/api/v1/events?type=label.deleted')
			);
			expect(
				events.items.some(
					(e) =>
						e.payload.name === docsName &&
						e.payload.forced === true &&
						e.payload.routing_rule_count === 1
				)
			).toBe(true);
		}
	);
});
