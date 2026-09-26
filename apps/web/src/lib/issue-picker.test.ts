import type { Issue } from '@tines/shared';
import { describe, expect, it } from 'vitest';
import { issueLabel, mergeIssueOptions, parseIssueQuery } from './issue-picker';

type Exact = Parameters<typeof mergeIssueOptions>[0];

const exact = (overrides: Partial<NonNullable<Exact>> = {}): NonNullable<Exact> => ({
	id: 'iss_12',
	number: 12,
	title: 'Launch checklist',
	effective_state: { category: 'active' } as Issue['effective_state'],
	duplicate_of: null,
	...overrides
});

const item = (n: number) => ({ id: `iss_${n}`, number: n, title: `Issue ${n}` });

describe('parseIssueQuery', () => {
	it.each(['#12', '12', ' #12 '])('reads %j as issue 12', (text) => {
		expect(parseIssueQuery(text)).toEqual({ q: '12', number: 12 });
	});

	it.each(['#', '12a', '#-1', '1e3', 'launch checklist', '#0', '99999999999999999999'])(
		'does not read %j as a number',
		(text) => {
			expect(parseIssueQuery(text).number).toBeNull();
		}
	);

	it('keeps title text as the search term', () => {
		expect(parseIssueQuery('  pricing page ')).toEqual({ q: 'pricing page', number: null });
	});
});

describe('mergeIssueOptions', () => {
	it('puts the exact number hit first and drops its duplicate from the search results', () => {
		const picks = mergeIssueOptions(exact(), [
			item(120),
			{ ...item(12), title: 'Launch checklist' }
		]);
		expect(picks.map((p) => p.id)).toEqual(['iss_12', 'iss_120']);
	});

	it('drops a done exact hit', () => {
		const done = exact({ effective_state: { category: 'done' } as Issue['effective_state'] });
		expect(mergeIssueOptions(done, [item(120)]).map((p) => p.id)).toEqual(['iss_120']);
	});

	it('drops an exact hit that is a duplicate', () => {
		const dup = exact({ duplicate_of: { id: 'iss_1' } as unknown as Issue['duplicate_of'] });
		expect(mergeIssueOptions(dup, []).map((p) => p.id)).toEqual([]);
	});

	it('caps the list, counting the exact hit', () => {
		const items = Array.from({ length: 20 }, (_, i) => item(i + 100));
		const picks = mergeIssueOptions(exact(), items, 8);
		expect(picks).toHaveLength(8);
		expect(picks[0].id).toBe('iss_12');
	});

	it('returns only the fields the picker needs', () => {
		expect(mergeIssueOptions(exact(), [])).toEqual([
			{ id: 'iss_12', number: 12, title: 'Launch checklist' }
		]);
	});
});

describe('issueLabel', () => {
	it('shows the number the app shows, then the title', () => {
		expect(issueLabel({ id: 'iss_12', number: 12, title: 'Launch checklist' })).toBe(
			'#12 Launch checklist'
		);
	});
});
