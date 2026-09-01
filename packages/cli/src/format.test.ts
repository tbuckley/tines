import { describe, expect, it } from 'vitest';
import {
	ageLabel,
	artifactSummary,
	byteSize,
	commentLines,
	contextItemSummary,
	formatTable,
	issueRef,
	keptWorkspaceRow,
	linkRows,
	prRefLabel,
	quotaLabel,
	recurrenceLabel,
	ruleTargetsLabel,
	runRow,
	runnerStatusLabel,
	scheduleRef,
	sniffContentType,
	timestamp
} from './format.js';

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

describe('commentLines', () => {
	const comment = {
		id: 'cmt_abc',
		issue_id: 'iss_1',
		body: 'first line\nsecond line',
		actor: { user_id: 'usr_1', user_name: 'alice', api_key_id: null, api_key_name: null },
		created_at: Date.UTC(2026, 7, 31, 1, 2, 3),
		updated_at: null
	};

	// The id is what `issues comment-edit`/`comment-delete` take, so `issues
	// show` is the only place an agent without a browser can find it.
	it('carries the comment id in the header, over an indented body', () => {
		expect(commentLines(comment)).toEqual([
			'',
			'  [2026-08-31 01:02:03] alice (cmt_abc):',
			'  first line',
			'  second line'
		]);
	});

	it('marks an edited comment and leaves an unedited one unmarked', () => {
		expect(commentLines({ ...comment, updated_at: Date.UTC(2026, 7, 31, 2) })[1]).toBe(
			'  [2026-08-31 01:02:03] alice (cmt_abc) (edited):'
		);
		expect(commentLines(comment)[1]).not.toContain('(edited)');
	});

	it('attributes a run-key comment to its runner and run', () => {
		const actor = {
			...comment.actor,
			api_key_id: 'key_1',
			api_key_name: 'run key',
			run: { run_id: 'arun_1', runner_name: 'macbook', issue_ref: { project_name: 'Tines', number: 11 } }
		};
		expect(commentLines({ ...comment, actor })[1]).toContain('alice via macbook · run on Tines/11');
	});
});

describe('contextItemSummary', () => {
	it.each([
		[{ kind: 'prompt', body: 'héllo' }, '6 bytes'],
		[{ kind: 'prompt' }, '0 bytes'],
		[{ kind: 'skill', file_count: 1 }, '1 file'],
		[{ kind: 'skill', file_count: 3 }, '3 files'],
		// A detail read carries the files themselves; a list read only counts them.
		[{ kind: 'skill', files: [{}, {}] }, '2 files'],
		[{ kind: 'skill' }, '0 files'],
		[{ kind: 'repo', repo_url: 'https://github.com/tbuckley/tines.git' }, 'https://github.com/tbuckley/tines.git'],
		[
			{ kind: 'repo', repo_url: 'https://github.com/tbuckley/tines.git', repo_branch: 'main' },
			'https://github.com/tbuckley/tines.git#main'
		],
		[{ kind: 'artifact', artifact_type: 'pr' }, 'pr'],
		[{ kind: 'artifact' }, 'artifact']
	])('%o summarizes as %j', (item, expected) => {
		expect(contextItemSummary(item as never)).toBe(expected);
	});
});

describe('artifactSummary', () => {
	const artifact = (type: string, version: Record<string, unknown>) =>
		({ artifact_type: type, current_version: version }) as never;

	it.each([
		[
			artifact('file', { filename: 'notes.pdf', content_type: 'application/pdf', size_bytes: 1024 }),
			'notes.pdf (application/pdf, 1024 bytes)'
		],
		[artifact('folder', { file_count: 1, size_bytes: 12 }), '1 file (12 bytes total)'],
		[artifact('folder', { file_count: 4, size_bytes: 900 }), '4 files (900 bytes total)'],
		[artifact('text', { filename: 'design-doc.md', content_type: 'text/markdown' }), 'design-doc.md (text/markdown)'],
		[artifact('link', { url: 'https://example.test/a', title: 'The spec' }), 'The spec — https://example.test/a'],
		[artifact('link', { url: 'https://example.test/a', title: null }), 'https://example.test/a'],
		// A link version with neither title nor url renders empty rather than "null".
		[artifact('link', { url: null, title: null }), ''],
		[
			artifact('pr', { pr_repo_url: 'https://github.com/tbuckley/tines', pr_number: 57 }),
			'tbuckley/tines#57 — https://github.com/tbuckley/tines/pull/57'
		]
	])('renders %#', (a, expected) => {
		expect(artifactSummary(a)).toBe(expected);
	});
});

describe('quotaLabel', () => {
	it('renders a global cap', () => {
		expect(quotaLabel({ type: 'global_cap', limit: 3 })).toBe('global cap: at most 3 concurrent runs');
	});

	it('renders a roster with no overrides', () => {
		expect(quotaLabel({ type: 'state_roster', default_limit: 2, overrides: {} })).toBe(
			'state roster: default 2 per state'
		);
	});

	it('renders overrides by raw state id when no resolver is given', () => {
		expect(quotaLabel({ type: 'state_roster', default_limit: 2, overrides: { wst_a: 1, wst_b: 4 } })).toBe(
			'state roster: default 2 per state, overrides: wst_a=1, wst_b=4'
		);
	});

	it('resolves override state names when a resolver is given', () => {
		const names: Record<string, string> = { wst_a: 'Design' };
		expect(
			quotaLabel({ type: 'state_roster', default_limit: 2, overrides: { wst_a: 1, wst_b: 4 } }, (id) => names[id] ?? id)
		).toBe('state roster: default 2 per state, overrides: Design=1, wst_b=4');
	});
});

describe('ruleTargetsLabel', () => {
	const target = (name: string, tier: string | null = null, status = 'active') => ({
		runner_id: `rnr_${name}`,
		runner_name: name,
		tier,
		runner_status: status
	});

	it.each([
		[[], '(no targets)'],
		[[target('mac')], 'mac'],
		[[target('mac', 'opus')], 'mac:opus'],
		[[target('mac', null, 'paused')], 'mac (paused)'],
		[[target('mac', 'opus', 'paused')], 'mac:opus (paused)'],
		[[target('mac', 'opus'), target('linux')], 'mac:opus → linux']
	])('renders %#', (targets, expected) => {
		expect(ruleTargetsLabel({ targets } as never)).toBe(expected);
	});
});

describe('sniffContentType', () => {
	it.each([
		['notes.md', 'text/markdown'],
		['a/b/report.PDF', 'application/pdf'],
		['shot.jpeg', 'image/jpeg'],
		['data.json', 'application/json'],
		// Unknown extension, no extension, and a dotfile all fall back.
		['archive.rar', 'application/octet-stream'],
		['Makefile', 'application/octet-stream'],
		['.gitignore', 'application/octet-stream'],
		// Only the last extension counts.
		['bundle.md.gz', 'application/gzip']
	])('%s sniffs as %s', (path, expected) => {
		expect(sniffContentType(path)).toBe(expected);
	});
});

describe('linkRows', () => {
	const linked = (number: number, title: string, category: string) => ({
		project_name: 'Tines',
		number,
		title,
		effective_state: { name: 'Design', category }
	});

	it('indents the ref and leaves the note empty by default', () => {
		expect(linkRows([linked(7, 'a thing', 'active')] as never)).toEqual([
			['  Tines/7', 'a thing', 'Design (active)', '']
		]);
	});

	it('fills the note column from the callback', () => {
		const rows = linkRows(
			[linked(7, 'open one', 'active'), linked(8, 'closed one', 'done')] as never,
			(e) => (e.effective_state.category === 'done' ? '' : '(open)')
		);
		expect(rows).toEqual([
			['  Tines/7', 'open one', 'Design (active)', '(open)'],
			['  Tines/8', 'closed one', 'Design (done)', '']
		]);
	});
});

describe('recurrenceLabel', () => {
	it.each([
		[{ kind: 'daily', time: '09:00' }, '0 9 * * *', 'Every day at 09:00, UTC'],
		// Not "Every month" — describeRecurrence words the monthly preset differently.
		[{ kind: 'monthly', day_of_month: 3, time: '09:00' }, '0 9 3 * *', 'Monthly on day 3 at 09:00, UTC'],
		[null, '*/5 * * * *', 'Cron “*/5 * * * *”, UTC']
	])('renders %#', (preset, cron, expected) => {
		expect(recurrenceLabel({ preset, cron, timezone: 'UTC' } as never)).toBe(expected);
	});
});

describe('scheduleRef', () => {
	it('joins project and schedule name', () => {
		expect(scheduleRef({ project_name: 'Tines', name: 'nightly' } as never)).toBe('Tines/nightly');
	});
});

describe('byteSize', () => {
	it.each([
		[0, '0 B'],
		[999, '999 B'],
		[1024, '1 KB'],
		[934_010, '912 KB'],
		[4_823_449, '4.6 MB'],
		[712_000_000, '679.0 MB'],
		[1_395_864_371, '1.3 GB']
	])('%i → %s', (bytes, expected) => {
		expect(byteSize(bytes)).toBe(expected);
	});
});

describe('ageLabel', () => {
	const now = Date.parse('2026-01-10T12:00:00.000Z');
	it.each([
		['2026-01-10T11:59:20.000Z', '40s'],
		['2026-01-10T11:20:00.000Z', '40m'],
		['2026-01-10T04:00:00.000Z', '8h'],
		['2026-01-05T12:00:00.000Z', '5d'],
		// A clock skew (or a marker written ahead of us) reads as brand new,
		// never as a negative age.
		['2026-01-11T00:00:00.000Z', '0s'],
		['not a date', '—']
	])('%s → %s', (iso, expected) => {
		expect(ageLabel(iso, now)).toBe(expected);
	});
});

describe('keptWorkspaceRow', () => {
	const now = Date.parse('2026-01-10T12:00:00.000Z');

	it('renders run, issue, status, age, size, and path', () => {
		expect(
			keptWorkspaceRow(
				{
					run_id: 'arun_1',
					issue_ref: 'Tines/19',
					status: 'failed',
					kept_at: '2026-01-09T12:00:00.000Z',
					path: '/home/x/.config/tines/workspaces/arun_1'
				},
				4_823_449,
				now
			)
		).toEqual([
			'arun_1',
			'Tines/19',
			'failed',
			'1d',
			'4.6 MB',
			'/home/x/.config/tines/workspaces/arun_1'
		]);
	});

	it('an orphan kept before issue refs were recorded still renders', () => {
		const row = keptWorkspaceRow(
			{ run_id: 'arun_2', status: 'completed', kept_at: '2026-01-10T11:00:00.000Z', path: '/w' },
			0,
			now
		);
		expect(row).toEqual(['arun_2', '—', 'completed', '1h', '0 B', '/w']);
	});
});
