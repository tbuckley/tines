import { describe, expect, it } from 'vitest';
import {
	canonicalSpendChanges,
	parseSpendSelection,
	patchSpendUrl,
	spendRequest
} from './spend-selection';

describe('spend selection', () => {
	it('defaults from focus and produces a stable population request', () => {
		const url = new URL('https://example.test/agents?unrelated=keep#place');
		const selection = parseSpendSelection(url, 'project-1');
		expect(selection).toMatchObject({
			project: 'project-1',
			window: '7d',
			view: 'workflow',
			workflow: 'all',
			sort: 'desc',
			ready: true
		});
		expect(spendRequest(selection)).toEqual({
			window: '7d',
			project: 'project-1',
			by: 'workflow'
		});
		expect(canonicalSpendChanges(url, 'project-1')).toEqual({
			spend_project: 'project-1',
			spend_window: '7d',
			spend_view: 'workflow',
			spend_sort: 'desc',
			spend_workflow: 'all'
		});
	});

	it('preserves unrelated URL state and excludes sort from the request key', () => {
		const url = new URL(
			'https://example.test/agents?agents_view=spend&spend_project=all&spend_window=30d&spend_sort=desc&x=1#groups'
		);
		const before = parseSpendSelection(url, null);
		const next = patchSpendUrl(url, { spend_sort: 'asc' });
		expect(next.searchParams.get('x')).toBe('1');
		expect(next.hash).toBe('#groups');
		expect(parseSpendSelection(next, null).requestKey).toBe(before.requestKey);
	});

	it('does not request incomplete custom ranges', () => {
		const selection = parseSpendSelection(
			new URL('https://example.test/agents?spend_window=custom&spend_from=2026-09-01'),
			null
		);
		expect(selection.ready).toBe(false);
	});
});
