import type { ContextItem, Label, Project } from '@tines/shared';
import { expect, test } from './fixtures';
import { ALICE } from './constants.mjs';
import { d1, sqlLiteral } from './d1';
import { body, gotoHydrated } from './helpers';

// Owner controls for shared guidance (Tines/752): a library item stays private
// until the owner includes it from the project page, and Remove takes it back
// out. The item is label-scoped to a fresh label so it cannot match any other
// test's issues while it exists.

const VIEWPORTS = [
	{ name: 'phone', width: 390, height: 844 },
	{ name: 'small-phone', width: 390, height: 560 },
	{ name: 'desktop', width: 1440, height: 900 }
] as const;

for (const viewport of VIEWPORTS) {
	test.describe(`owner guidance controls at ${viewport.name}`, () => {
		test.use({
			signedIn: ALICE,
			viewport: { width: viewport.width, height: viewport.height },
			colorScheme: viewport.name === 'desktop' ? 'light' : 'dark'
		});

		test('include from library, review, and remove', async ({
			page,
			apiFor,
			uniqueName
		}, testInfo) => {
			const api = apiFor(ALICE);
			const project = await body<Project>(
				await api.post('/api/v1/projects', { name: uniqueName('guidance-controls') })
			);
			const label = await body<Label>(
				await api.post('/api/v1/labels', { name: uniqueName('guidance'), color: 'blue' })
			);
			const itemName = uniqueName('included-prompt');
			const item = await body<ContextItem>(
				await api.post('/api/v1/context', {
					kind: 'prompt',
					name: itemName,
					label_id: label.id,
					body: 'Shared only after the owner includes it.'
				})
			);
			try {
				d1(
					`UPDATE project SET shared_at = ${Date.now()}, sharing_revision = 1 WHERE id = ${sqlLiteral(project.id)}`
				);
				await gotoHydrated(page, `/projects/${project.id}`);
				const card = page.getByRole('region', { name: 'Shared guidance' });
				await card.scrollIntoViewIfNeeded();
				await expect(card).toBeVisible();
				const included = card.getByRole('list', { name: 'Included from your library' });
				await expect(included).toHaveCount(0);

				// Keyboard: Escape closes the picker and focus returns to its opener.
				const opener = card.getByRole('button', { name: 'Include from library' });
				await opener.click();
				const dialog = page.getByRole('dialog', { name: 'Include from library' });
				await expect(dialog).toBeVisible();
				await page.keyboard.press('Escape');
				await expect(dialog).toBeHidden();
				await expect(opener).toBeFocused();

				await opener.click();
				await dialog.getByRole('textbox', { name: 'Search your library' }).fill(itemName);
				const includeButton = dialog.getByRole('button', { name: `Include ${itemName}` });
				await expect(includeButton).toBeVisible();
				const box = await includeButton.boundingBox();
				if (viewport.width < 640) expect(box!.height).toBeGreaterThanOrEqual(44);
				await testInfo.attach(`picker-${viewport.name}`, {
					body: await page.screenshot(),
					contentType: 'image/png'
				});
				await includeButton.click();
				await expect(dialog.getByRole('button', { name: `Include ${itemName}` })).toHaveCount(0);
				await page.keyboard.press('Escape');

				await expect(included.getByText(itemName)).toBeVisible();
				expect(
					d1<{ n: number }>(
						`SELECT count(*) AS n FROM project_guidance_inclusion
						 WHERE project_id = ${sqlLiteral(project.id)} AND context_item_id = ${sqlLiteral(item.id)}`
					)[0].n
				).toBe(1);

				await card.getByText('Review shared guidance').click();
				await expect(
					card.getByRole('heading', { name: 'Included from your library' })
				).toBeVisible();
				await card.scrollIntoViewIfNeeded();
				await testInfo.attach(`card-${viewport.name}`, {
					body: await page.screenshot({ fullPage: true }),
					contentType: 'image/png'
				});

				await card.getByRole('button', { name: `Remove ${itemName} from shared guidance` }).click();
				await expect(included).toHaveCount(0);
				await expect(card.getByText('Nothing included.')).toBeVisible();
			} finally {
				await api.delete(`/api/v1/context/${item.id}`);
			}
		});
	});
}
