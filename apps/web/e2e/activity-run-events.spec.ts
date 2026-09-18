/**
 * Run outcomes must remain scannable on every surface backed by EventList.
 * The rows deliberately cover both sides of the outcome precedence: an
 * interrupted failure warns instead of failing, while an unknown outcome
 * stays muted instead of being broadened into a warning or success.
 */
import type { Locator, Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { ACTIVITY_RUN_EVENTS, ALICE } from './constants.mjs';
import { resetFocus } from './helpers';

type ExpectedPresentation = {
	runner: string;
	icon: string;
	colorClasses: string[];
};

const presentations: ExpectedPresentation[] = [
	{ runner: 'activity-start', icon: 'robot', colorClasses: ['text-primary'] },
	{ runner: 'activity-success', icon: 'circle-check', colorClasses: ['text-emerald-600'] },
	{ runner: 'activity-failure', icon: 'circle-x', colorClasses: ['text-destructive'] },
	{ runner: 'activity-interrupted', icon: 'alert-triangle', colorClasses: ['text-amber-700'] },
	{ runner: 'activity-stalled', icon: 'alert-triangle', colorClasses: ['text-amber-700'] },
	{ runner: 'activity-unknown', icon: 'robot', colorClasses: ['text-muted-foreground'] }
];

function eventRow(page: Page, runner: string): Locator {
	return page.locator('li:not([inert])', { hasText: runner });
}

async function expectPresentations(page: Page): Promise<void> {
	for (const expected of presentations) {
		const row = eventRow(page, expected.runner);
		await expect(row).toHaveCount(1);
		const badge = row.locator(':scope > span[aria-hidden="true"]');
		await expect(badge).toHaveCount(1);
		await expect(badge.locator('svg')).toHaveClass(
			new RegExp(`tabler-icon-${expected.icon}(?:\\s|$)`)
		);
		for (const colorClass of expected.colorClasses) {
			await expect(badge).toHaveClass(new RegExp(`(?:^|\\s)${colorClass}(?:\\s|$)`));
		}
	}
}

test.describe('activity run-event presentation', () => {
	test.use({ signedIn: ALICE });
	test.beforeEach(async ({ request }) => {
		await resetFocus(request);
	});

	// `/activity?project=…` is the sticky focus one-shot: the server persists
	// the project as Alice's focus before redirecting. Specs share one user,
	// so leave the focus the way it was found — the next spec on the shard
	// (context.spec.ts) lists workflow-scoped items that a focus would hide.
	test.afterEach(async ({ request }) => {
		await resetFocus(request);
	});

	test('shows each run outcome on the global, recorded, and issue feeds', async ({ page }) => {
		const recorded = new URLSearchParams(
			ACTIVITY_RUN_EVENTS.events.map((event) => ['event', event.id])
		);
		const surfaces = [
			`/activity?project=${encodeURIComponent(ACTIVITY_RUN_EVENTS.projectName)}`,
			`/activity/recorded?${recorded}`,
			`/issues/${encodeURIComponent(ACTIVITY_RUN_EVENTS.projectName)}/${ACTIVITY_RUN_EVENTS.issueNumber}`
		];

		for (const surface of surfaces) {
			await page.goto(surface);
			await expectPresentations(page);
		}
	});
});
