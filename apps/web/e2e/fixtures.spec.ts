import type { ListResponse, Project } from '@tines/shared';
import { ALICE, BOB } from './constants.mjs';
import { expect, test } from './fixtures';
import { body, signIn } from './helpers';

test.describe('shared fixture contract', () => {
	test('allocates repeated names and respects length limits', async ({ uniqueName }) => {
		const first = uniqueName('fixture-name');
		const second = uniqueName('fixture-name');
		expect(first).not.toBe(second);
		expect(first.length).toBeLessThanOrEqual(50);
		expect(uniqueName('x'.repeat(200), { maxLength: 100 })).toHaveLength(100);
		expect(() => uniqueName('   ')).toThrow(/non-empty stem/);
		expect(() => uniqueName('x', { maxLength: 1 })).toThrow(/too short/);
	});

	test('keeps Alice and Bob bearer access isolated', async ({ apiFor, uniqueName }) => {
		const alice = apiFor(ALICE);
		const bob = apiFor(BOB);
		const project = await body<Project>(
			await alice.post('/api/v1/projects', { name: uniqueName('fixture-cross-file') })
		);
		const bobProjects = await body<ListResponse<Project>>(await bob.get('/api/v1/projects'));
		expect(bobProjects.items.map(({ id }) => id)).not.toContain(project.id);
	});

	test.describe('with Alice selected', () => {
		test.use({ signedIn: ALICE, viewport: { width: 702, height: 533 }, colorScheme: 'dark' });

		test('signs in lazily and preserves context options', async ({ page }) => {
			await page.goto('/issues');
			await expect(page.getByRole('heading', { name: 'Issues' })).toBeVisible();
			expect(await page.viewportSize()).toEqual({ width: 702, height: 533 });
			expect(await page.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches)).toBe(
				true
			);
		});

		test('allows an intentional account switch', async ({ context, page }) => {
			await signIn(context, BOB.sessionToken);
			await page.goto('/issues');
			await expect(page.getByRole('heading', { name: 'Issues' })).toBeVisible();
		});
	});

	test('leaves public contexts unsigned', async ({ page }) => {
		await page.goto('/');
		await expect(page.getByRole('button', { name: 'Sign in ↗' }).first()).toBeVisible();
	});
});
