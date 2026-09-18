import { ageLabel as sharedAgeLabel } from '@tines/shared';
import type { Comment, Round, RoundRun, SinceLastRun } from '@tines/shared';
import { describe, expect, it } from 'vitest';
import {
	ageLabel,
	arrivedViaLabel,
	artifactSummary,
	artifactTypeLabel,
	byteSize,
	commentLines,
	contextItemSummary,
	formatTable,
	issueRef,
	keptWorkspaceRow,
	linkRows,
	prRefLabel,
	requirementLines,
	quotaLabel,
	roundLines,
	roundSummaryLabel,
	sinceLastRunLines,
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
		expect(
			formatTable([
				['REF', 'TITLE'],
				['Proj/1', 'a'],
				['Proj/100', 'bb']
			])
		).toBe('REF       TITLE\nProj/1    a\nProj/100  bb');
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
		status: 'completed',
		created_at: Date.UTC(2026, 7, 31),
		started_at: Date.UTC(2026, 7, 31),
		ended_at: Date.UTC(2026, 7, 31) + 90_000
	};

	it("falls back to '—' when there is no usage to report", () => {
		expect(runRow(base as never)).toContain('—');
	});

	it('renders dollars when the cost is known', () => {
		expect(runRow({ ...base, usage: { cost_usd: 1.5 } } as never)).toContain('$1.50 Recorded');
		expect(runRow({ ...base, usage: { cost_usd: 0, cost_source: 'provider' } } as never)).toContain(
			'$0 Reported'
		);
		expect(
			runRow({ ...base, usage: { cost_usd: 0.001, cost_source: 'priced' } } as never)
		).toContain('<$0.01 Estimated');
	});

	it('keeps unknown and explicit-zero token states honest', () => {
		expect(runRow({ ...base, usage: { cost_source: 'none' } } as never)).toContain('Unreported');
		expect(runRow({ ...base, usage: { input_tokens: 0, output_tokens: 0 } } as never)).toContain(
			'Unpriced'
		);
	});

	it('shows confirmed resume lineage in the status cell', () => {
		expect(runRow({ ...base, resumed_from_run_id: 'arun_old' } as never)).toContain(
			'completed · resumed run arun_old'
		);
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
			run: {
				run_id: 'arun_1',
				runner_name: 'macbook',
				issue_ref: { project_name: 'Tines', number: 11 }
			}
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
		[
			{ kind: 'repo', repo_url: 'https://github.com/tbuckley/tines.git' },
			'https://github.com/tbuckley/tines.git'
		],
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
			artifact('file', {
				filename: 'notes.pdf',
				content_type: 'application/pdf',
				size_bytes: 1024
			}),
			'notes.pdf (application/pdf, 1024 bytes)'
		],
		[artifact('folder', { file_count: 1, size_bytes: 12 }), '1 file (12 bytes total)'],
		[artifact('folder', { file_count: 4, size_bytes: 900 }), '4 files (900 bytes total)'],
		[
			artifact('text', { filename: 'design-doc.md', content_type: 'text/markdown' }),
			'design-doc.md (text/markdown)'
		],
		[
			artifact('link', { url: 'https://example.test/a', title: 'The spec' }),
			'The spec — https://example.test/a'
		],
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
		expect(quotaLabel({ type: 'global_cap', limit: 3 })).toBe(
			'global cap: at most 3 concurrent runs'
		);
	});

	it('renders a roster with no overrides', () => {
		expect(quotaLabel({ type: 'state_roster', default_limit: 2, overrides: {} })).toBe(
			'state roster: default 2 per state'
		);
	});

	it('renders overrides by raw state id when no resolver is given', () => {
		expect(
			quotaLabel({ type: 'state_roster', default_limit: 2, overrides: { wst_a: 1, wst_b: 4 } })
		).toBe('state roster: default 2 per state, overrides: wst_a=1, wst_b=4');
	});

	it('resolves override state names when a resolver is given', () => {
		const names: Record<string, string> = { wst_a: 'Design' };
		expect(
			quotaLabel(
				{ type: 'state_roster', default_limit: 2, overrides: { wst_a: 1, wst_b: 4 } },
				(id) => names[id] ?? id
			)
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
		[[target('mac')], '1. mac'],
		[[target('mac', 'opus')], '1. mac:opus'],
		[[target('mac', null, 'paused')], '1. mac (paused)'],
		[[target('mac', 'opus', 'paused')], '1. mac:opus (paused)'],
		[[target('mac', 'opus'), target('linux')], '1. mac:opus → 2. linux']
	])('renders %#', (targets, expected) => {
		expect(ruleTargetsLabel({ targets } as never)).toBe(expected);
	});

	it('renders routed effort without confusing it with the tier', () => {
		expect(
			ruleTargetsLabel({ targets: [{ ...target('mac', 'balanced'), effort: 'xhigh' }] } as never)
		).toBe('1. mac:balanced effort=xhigh');
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
		[
			{ kind: 'monthly', day_of_month: 3, time: '09:00' },
			'0 9 3 * *',
			'Monthly on day 3 at 09:00, UTC'
		],
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

describe('artifactTypeLabel', () => {
	it.each([
		['text' as const, 'text/markdown', 'text, text/markdown'],
		['file' as const, 'image/png', 'file, image/png'],
		// A type with no content type of its own reads as the bare type.
		['folder' as const, null, 'folder'],
		['link' as const, null, 'link'],
		['pr' as const, null, 'pr']
	])('labels a %s artifact', (type, contentType, expected) => {
		expect(
			artifactTypeLabel({
				artifact_type: type,
				current_version: { content_type: contentType } as never
			})
		).toBe(expected);
	});
});

describe('requirementLines', () => {
	const base = {
		artifact: 'prd',
		type: 'text' as const,
		content_type: 'text/markdown',
		description: 'The product requirements',
		fix: 'tines issues artifacts attach Proj/1 prd --text @prd.md'
	};

	it('names the slot, its spec, the status, the description and the fix', () => {
		expect(
			requirementLines({ ...base, status: 'missing', current_type: null, current_version: null })
		).toEqual([
			'requires artifact "prd" (text, text/markdown): missing — The product requirements',
			'  fix: tines issues artifacts attach Proj/1 prd --text @prd.md'
		]);
	});

	it.each([
		[{ status: 'satisfied' as const, current_type: 'text' as const }, 'satisfied (v2)'],
		[
			{ status: 'stale' as const, current_type: 'text' as const },
			'stale (v2, attached before the current state)'
		],
		[
			{ status: 'type_mismatch' as const, current_type: 'link' as const },
			'type mismatch (holds link)'
		],
		[
			{ status: 'type_mismatch' as const, current_type: 'text' as const },
			'type mismatch (v2 is not text/markdown)'
		]
	])('reports the %o status', (over, expected) => {
		const [line] = requirementLines({
			...base,
			...over,
			current_version: { version: 2, created_at: 0 }
		});
		expect(line).toContain(`: ${expected}`);
	});

	it('renders the reaffirm alternative as its own line, never on the fix line', () => {
		// Two commands, two lines: a reader copies one span and it runs. Packing
		// both into `fix` is what Tines/255 removed, so the `or:` line is the
		// only place the reaffirm may appear.
		expect(
			requirementLines({
				...base,
				status: 'stale',
				current_type: 'text',
				current_version: { version: 2, created_at: 0 },
				fix: 'tines issues artifacts attach Proj/1 prd prd.md',
				fix_alternative: 'tines issues artifacts reaffirm Proj/1 prd'
			})
		).toEqual([
			'requires artifact "prd" (text, text/markdown): stale (v2, attached before the current state) — The product requirements',
			'  fix: tines issues artifacts attach Proj/1 prd prd.md',
			'  or: tines issues artifacts reaffirm Proj/1 prd'
		]);
	});

	it('drops the or: line when the requirement has no alternative', () => {
		expect(
			requirementLines({ ...base, status: 'missing', current_type: null, current_version: null })
		).not.toContainEqual(expect.stringContaining('  or: '));
	});

	it('drops the fix line when the server sent none', () => {
		expect(
			requirementLines({
				artifact: 'notes',
				status: 'missing',
				current_type: null,
				current_version: null,
				fix: ''
			})
		).toEqual(['requires artifact "notes": missing']);
	});
});

describe('the handoff sections', () => {
	const NOW = 1_700_000_000_000;
	const human = {
		user_id: 'u1',
		user_name: 'Tom Buckley',
		api_key_id: null,
		api_key_name: null
	};
	const comment = (id: string, body: string, at: number): Comment => ({
		id,
		issue_id: 'iss_1',
		body,
		actor: human,
		created_at: at,
		updated_at: null
	});
	const run = (over: Partial<RoundRun> = {}): RoundRun => ({
		run_id: 'arun_late',
		runner_name: 'macbook',
		status: 'completed',
		outcome: 'advanced',
		started_at: NOW - 3_600_000,
		ended_at: NOW - 3_000_000,
		usage: null,
		transition: {
			action: 'Submit for automated review',
			from_state: { id: 's_impl', name: 'Implementation' },
			to_state: { id: 's_ar', name: 'Automated Review' },
			actor: { user_id: 'u1', user_name: 'Tom Buckley', api_key_id: 'ak_1', api_key_name: 'run' },
			at: NOW - 3_000_000
		},
		summary_comment: { id: 'cmt_sum', body: 'Implementation\nlanded the thing.', created_at: NOW },
		earlier_comment_ids: ['cmt_a', 'cmt_b'],
		artifacts: [
			{
				name: 'impl-pr',
				artifact_type: 'pr',
				from_version: null,
				to_version: 1,
				pr_url: 'https://github.com/tbuckley/tines/pull/129',
				files: null
			}
		],
		returned_via: null,
		...over
	});

	describe('roundLines', () => {
		const round: Round = {
			boundary: {
				action: 'Send back to implementation',
				from_state: { id: 's_hr', name: 'Human Review' },
				to_state: { id: 's_impl', name: 'Implementation' },
				actor: human,
				at: NOW - 7_200_000
			},
			boundary_at: NOW - 7_200_000,
			stages: [
				{
					state: { id: 's_impl', name: 'Implementation', position: 3 },
					runs: [
						run(),
						run({
							run_id: 'arun_early',
							outcome: 'stalled',
							transition: null,
							summary_comment: null,
							earlier_comment_ids: [],
							artifacts: [],
							returned_via: {
								action: 'Review failed',
								from_state: { id: 's_ar', name: 'Automated Review' },
								to_state: { id: 's_impl', name: 'Implementation' },
								actor: {
									user_id: 'u1',
									user_name: 'Tom Buckley',
									api_key_id: 'ak_2',
									api_key_name: 'run'
								},
								at: NOW - 5_000_000
							}
						})
					]
				}
			],
			run_count: 2
		};

		it('heads the round with its boundary and names every run', () => {
			const lines = roundLines(round, NOW);
			expect(lines[0]).toContain('round (2 runs since Tom Buckley moved "Send back to');
			expect(lines.join('\n')).toContain(
				'Implementation — arun_late on macbook · 10m · advanced · "Submit for automated review" → Automated Review'
			);
		});

		it('spells out the latest run only, folding the earlier attempt to one line', () => {
			const text = roundLines(round, NOW).join('\n');
			expect(text).toContain('impl-pr v1 (https://github.com/tbuckley/tines/pull/129)');
			expect(text).toContain('summary (cmt_sum):');
			expect(text).toContain('landed the thing.');
			expect(text).toContain('2 earlier comments: cmt_a, cmt_b');
			// The earlier attempt gets its one line, naming what ended it, and
			// none of the detail the stage's latest run gets.
			expect(text).toContain('arun_early · 10m · stalled · sent back by Automated Review');
			expect(text.match(/summary \(/g)).toHaveLength(1);
		});

		it('puts the earlier attempt above the summary body and adds no counter after it', () => {
			const lines = roundLines(round, NOW);
			const text = lines.join('\n');
			// The attempt lines say how many attempts there were, so a "N earlier
			// attempts folded above" counter would only restate them — and it used
			// to land after a summary body long enough to swallow it.
			expect(text).not.toContain('folded above');
			expect(lines.findIndex((l) => l.includes('arun_early'))).toBeLessThan(
				lines.findIndex((l) => l.includes('summary (cmt_sum)'))
			);
		});

		it('pluralises the folded-comment count', () => {
			const one = roundLines(
				{
					...round,
					stages: [
						{
							...round.stages[0],
							runs: [run({ earlier_comment_ids: ['cmt_a'] }), round.stages[0].runs[1]]
						}
					]
				},
				NOW
			).join('\n');
			expect(one).toContain('1 earlier comment: cmt_a');
			expect(one).not.toContain('1 earlier comments');
		});

		it('says "since created" when no human transition opened the round', () => {
			const lines = roundLines({ ...round, boundary: null }, NOW);
			expect(lines[0]).toContain('since created');
		});
	});

	describe('sinceLastRunLines', () => {
		const since: SinceLastRun = {
			previous_run: {
				run_id: 'arun_prev',
				ended_at: NOW - 7_200_000,
				state_at_start_name: 'Implementation'
			},
			transition: {
				action: 'Send back to implementation',
				from_state: { id: 's_hr', name: 'Human Review' },
				to_state: { id: 's_impl', name: 'Implementation' },
				actor: human,
				at: NOW - 3_600_000
			},
			comments: [comment('cmt_h', 'CI is red on the e2e job.', NOW - 3_500_000)],
			comment_count: 1,
			stale_artifacts: ['impl-pr']
		};

		it('names the previous run, the human move and what went stale', () => {
			const text = sinceLastRunLines(since, NOW).join('\n');
			expect(text).toContain('since the last run (Implementation, arun_prev ended 2h ago):');
			expect(text).toContain(
				'moved from Human Review via "Send back to implementation" by Tom Buckley 1h ago — now stale: impl-pr'
			);
			expect(text).toContain('CI is red on the e2e job.');
		});

		it('renders a forced move as "moved directly" and reports the comment cap', () => {
			const text = sinceLastRunLines(
				{
					...since,
					transition: { ...since.transition!, action: null },
					stale_artifacts: [],
					comment_count: 13
				},
				NOW
			).join('\n');
			expect(text).toContain('moved from Human Review moved directly by Tom Buckley 1h ago');
			expect(text).not.toContain('now stale');
			expect(text).toContain('… and 12 earlier comments');
		});

		it('pluralises the comment-cap trailer for a single hidden comment', () => {
			const text = sinceLastRunLines({ ...since, comment_count: 2 }, NOW).join('\n');
			expect(text).toContain('… and 1 earlier comment');
			expect(text).not.toContain('1 earlier comments');
		});

		it('drops the move line on a comment-only steer', () => {
			const text = sinceLastRunLines({ ...since, transition: null }, NOW).join('\n');
			expect(text).not.toContain('moved from');
			expect(text).toContain('CI is red on the e2e job.');
		});
	});

	describe('the awaiting-human columns', () => {
		it('labels how the issue arrived, falling back for a forced move', () => {
			expect(
				arrivedViaLabel({ action: 'Review passed', from_state_name: 'x', by_run: true, at: 0 })
			).toBe('Review passed');
			expect(arrivedViaLabel({ action: null, from_state_name: null, by_run: false, at: 0 })).toBe(
				'moved directly'
			);
			expect(arrivedViaLabel(null)).toBe('—');
		});

		it('summarises the round as the PR number and the artifacts it produced', () => {
			expect(
				roundSummaryLabel({
					pr_url: 'https://github.com/tbuckley/tines/pull/129',
					artifacts: [{ name: 'review-notes', artifact_type: 'text', version: 2 }]
				})
			).toBe('PR 129 · review-notes v2');
			expect(roundSummaryLabel({ pr_url: null, artifacts: [] })).toBe('—');
			expect(roundSummaryLabel(null)).toBe('—');
		});
	});
});

describe('ageLabel delegation', () => {
	// One spelling of an age across the launch prompt and the CLI: the ISO form
	// here is the shared helper with a Date.parse in front of it.
	it('is the shared helper with the ISO string parsed', () => {
		const now = Date.parse('2026-09-06T12:00:00.000Z');
		for (const ms of [12_000, 900_000, 40_000_000, 400_000_000]) {
			expect(ageLabel(new Date(now - ms).toISOString(), now)).toBe(sharedAgeLabel(now - ms, now));
		}
	});
});
