import type { Issue } from '@tines/shared';
import { describe, expect, it } from 'vitest';
import { issueLabel, mergeIssueOptions, parseIssueQuery } from './issue-picker';

type Candidate = NonNullable<Parameters<typeof mergeIssueOptions>[0]>;

const state = (category: 'active' | 'done') => ({ category }) as Issue['effective_state'];

const item = (n: number, overrides: Partial<Candidate> = {}): Candidate => ({
	id: `iss_${n}`,
	number: n,
	title: `Issue ${n}`,
	project_id: 'prj_1',
	project_name: 'Tines',
	workflow_id: 'wf_1',
	effective_state: state('active'),
	duplicate_of: null,
	...overrides
});

const exact = (overrides: Partial<Candidate> = {}) =>
	item(12, { title: 'Launch checklist', ...overrides });

const done = { effective_state: state('done') };
const dup = { duplicate_of: { id: 'iss_1' } as unknown as Issue['duplicate_of'] };

describe('parseIssueQuery', () => {
	it.each(['#12', '12', ' #12 '])('reads %j as issue 12', (text) => {
		expect(parseIssueQuery(text)).toEqual({ q: '12', number: 12, project: null });
	});

	it.each(['#', '12a', '#-1', '1e3', 'launch checklist', '#0', '99999999999999999999'])(
		'does not read %j as a number',
		(text) => {
			expect(parseIssueQuery(text)).toMatchObject({ number: null, project: null });
		}
	);

	it('keeps title text as the search term', () => {
		expect(parseIssueQuery('  pricing page ')).toEqual({
			q: 'pricing page',
			number: null,
			project: null
		});
	});

	it.each([
		['Tines/50', 'Tines'],
		['Tines/#50', 'Tines'],
		[' Tines / 50 ', 'Tines'],
		['My project/50', 'My project'],
		['a/b/50', 'a/b']
	])('reads %j as issue 50 of a named project', (text, project) => {
		expect(parseIssueQuery(text)).toEqual({ q: text.trim(), number: 50, project });
	});

	it.each(['Tines/', 'Tines/abc', '/50', 'Tines/0', 'Tines/50/'])(
		'does not read %j as a project ref',
		(text) => {
			expect(parseIssueQuery(text)).toMatchObject({ number: null, project: null });
		}
	);
});

describe('mergeIssueOptions', () => {
	const ids = (picks: { id: string }[]) => picks.map((p) => p.id);

	it('puts the exact number hit first and drops its duplicate from the search results', () => {
		const picks = mergeIssueOptions(exact(), [item(120), exact()]);
		expect(ids(picks)).toEqual(['iss_12', 'iss_120']);
	});

	it('drops a done exact hit', () => {
		expect(ids(mergeIssueOptions(exact(done), [item(120)]))).toEqual(['iss_120']);
	});

	it('drops an exact hit that is a duplicate', () => {
		expect(ids(mergeIssueOptions(exact(dup), []))).toEqual([]);
	});

	it('keeps done issues when asked, below the open ones but never above the exact hit', () => {
		const picks = mergeIssueOptions(exact(done), [item(1, done), item(2), item(3, done), item(4)], {
			includeDone: true
		});
		expect(ids(picks)).toEqual(['iss_12', 'iss_2', 'iss_4', 'iss_1', 'iss_3']);
	});

	it('keeps duplicates when asked, and only then', () => {
		expect(ids(mergeIssueOptions(exact(dup), [item(1, dup)], { includeDuplicates: true }))).toEqual(
			['iss_12', 'iss_1']
		);
		expect(ids(mergeIssueOptions(null, [item(1, dup), item(2)], { includeDone: true }))).toEqual([
			'iss_2'
		]);
	});

	it('never offers an excluded issue, as the exact hit or as a result', () => {
		const picks = mergeIssueOptions(exact(), [item(1), item(2)], {
			exclude: new Set(['iss_12', 'iss_1'])
		});
		expect(ids(picks)).toEqual(['iss_2']);
	});

	it('fills the cap from what is left after exclusions', () => {
		const items = Array.from({ length: 6 }, (_, i) => item(i + 1));
		const picks = mergeIssueOptions(null, items, { limit: 3, exclude: ['iss_1', 'iss_2'] });
		expect(ids(picks)).toEqual(['iss_3', 'iss_4', 'iss_5']);
	});

	it('caps the list, counting the exact hit', () => {
		const items = Array.from({ length: 20 }, (_, i) => item(i + 100));
		const picks = mergeIssueOptions(exact(), items, { limit: 8 });
		expect(picks).toHaveLength(8);
		expect(picks[0].id).toBe('iss_12');
	});

	it('returns only the fields the picker needs', () => {
		expect(mergeIssueOptions(exact(), [])).toEqual([
			{
				id: 'iss_12',
				number: 12,
				title: 'Launch checklist',
				project_id: 'prj_1',
				project_name: 'Tines',
				workflow_id: 'wf_1',
				effective_state: { category: 'active' }
			}
		]);
	});
});

describe('issueLabel', () => {
	it('shows the number the app shows, then the title', () => {
		expect(issueLabel(exact())).toBe('#12 Launch checklist');
	});

	it('names the project when the picker spans projects', () => {
		expect(issueLabel(exact(), true)).toBe('Tines/#12 Launch checklist');
	});
});
