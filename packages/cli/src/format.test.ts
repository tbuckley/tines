import { describe, expect, it } from 'vitest';
import { formatTable, issueRef, prRefLabel, runRow, runnerStatusLabel, timestamp } from './format.js';

describe('formatTable', () => {
	it('pads columns to the widest cell and trims the trailing one', () => {
		expect(formatTable([
			['REF', 'TITLE'],
			['Proj/1', 'a'],
			['Proj/100', 'bb']
		])).toBe('REF       TITLE\nProj/1    a\nProj/100  bb');
	});

	it('renders nothing for no rows', () => {
		expect(formatTable([])).toBe('');
	});
});

describe('timestamp', () => {
	it('renders UTC to the second, space-separated', () => {
		expect(timestamp(Date.UTC(2026, 7, 31, 1, 2, 3))).toBe('2026-08-31 01:02:03');
	});
});

describe('issueRef', () => {
	it('joins project and number', () => {
		expect(issueRef({ project_name: 'Tines', number: 50 })).toBe('Tines/50');
	});
});

describe('prRefLabel', () => {
	it('renders <owner/repo>#<number>', () => {
		expect(prRefLabel({ pr_repo_url: 'https://github.com/tbuckley/tines', pr_number: 7 })).toBe(
			'tbuckley/tines#7'
		);
	});
});

describe('runnerStatusLabel', () => {
	it.each([
		[{ status: 'paused', online: true }, 'paused'],
		[{ status: 'active', online: true }, 'online'],
		[{ status: 'active', online: false }, 'offline']
	])('%o renders as %j', (runner, label) => {
		expect(runnerStatusLabel(runner as never)).toBe(label);
	});
});

describe('runRow', () => {
	const base = {
		id: 'arun_1',
		status: 'succeeded',
		created_at: Date.UTC(2026, 7, 31),
		started_at: Date.UTC(2026, 7, 31),
		ended_at: Date.UTC(2026, 7, 31) + 90_000
	};

	it("falls back to '—' when there is no usage to report", () => {
		expect(runRow(base as never)).toContain('—');
	});

	it('renders dollars when the cost is known', () => {
		expect(runRow({ ...base, usage: { cost_usd: 1.5 } } as never)).toContain('$1.50');
	});
});
