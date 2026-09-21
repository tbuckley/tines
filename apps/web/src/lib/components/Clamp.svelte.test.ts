import { describe, expect, it } from 'vitest';
import { createRawSnippet } from 'svelte';
import { render } from 'vitest-browser-svelte';
import Clamp from './Clamp.svelte';

/** Content of a known height, so whether it overflows the cap is not in doubt. */
function block(height: string) {
	return createRawSnippet(() => ({
		render: () => `<div style="height: ${height}" data-testid="content"></div>`
	}));
}

const cap = '10rem';

describe('Clamp', () => {
	it('stays toggle-free when the content already fits', async () => {
		const screen = await render(Clamp, { maxHeight: cap, children: block('4rem') });
		await expect.element(screen.getByRole('button')).not.toBeInTheDocument();
	});

	it('offers the toggle only once the content really overflows the cap', async () => {
		const screen = await render(Clamp, { maxHeight: cap, children: block('40rem') });
		await expect.element(screen.getByRole('button', { name: 'Show more' })).toBeVisible();
	});

	it('holds the content to the cap until asked, then lets it out', async () => {
		const screen = await render(Clamp, { maxHeight: cap, children: block('40rem') });
		const clamped = screen.getByTestId('content').element().parentElement!;

		expect(clamped.clientHeight).toBeCloseTo(160, 0);
		expect(clamped.scrollHeight).toBeGreaterThan(clamped.clientHeight);

		await screen.getByRole('button', { name: 'Show more' }).click();

		expect(clamped.clientHeight).toBeCloseTo(640, 0);
		await expect.element(screen.getByRole('button', { name: 'Show less' })).toBeVisible();
	});

	it('keeps the toggle after folding back, so the reader can open it again', async () => {
		const screen = await render(Clamp, { maxHeight: cap, children: block('40rem') });

		await screen.getByRole('button', { name: 'Show more' }).click();
		await screen.getByRole('button', { name: 'Show less' }).click();

		await expect.element(screen.getByRole('button', { name: 'Show more' })).toBeVisible();
	});

	it('fades the cut edge while clamped and drops the fade once expanded', async () => {
		const screen = await render(Clamp, { maxHeight: cap, children: block('40rem') });
		const fade = () => screen.container.querySelector('[aria-hidden="true"]');

		expect(fade()).not.toBeNull();
		await screen.getByRole('button', { name: 'Show more' }).click();
		expect(fade()).toBeNull();
	});
});
