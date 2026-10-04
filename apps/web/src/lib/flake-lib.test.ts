import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
	buildLedger,
	knownIssue,
	parseJsonReport,
	parseListLog,
	renderLedger,
	renderSummary,
	type FlakeObservation
} from '../../scripts/flake-lib.mjs';

const TITLE = 'native D1 workflow install gate › makes concurrent retries one-copy';
// What `gh run view --log` prints: job, step and timestamp ahead of each line.
const at = (line: string) =>
	`Playwright e2e (1)\tUNKNOWN STEP\t2026-09-26T20:34:49.2760848Z ${line}`;

describe('parseListLog', () => {
	it('reads a failure block with its error line', () => {
		const log = [
			at('  ✓   12 e2e/api-keys.spec.ts:168:2 › API keys page › creates a key (1.1s)'),
			at('[WebServer] ✘ [ERROR] API error: Error: D1_ERROR: database is locked'),
			at(`  ✘   13 e2e/native-install.spec.ts:853:2 › ${TITLE} (8.4s)`),
			at(`  1) e2e/native-install.spec.ts:853:2 › ${TITLE} `),
			at(''),
			at('    Error: 409 Conflict — plan_stale: The reviewed destination changed'),
			at('  1 failed')
		].join('\n');
		expect(parseListLog(log)).toEqual([
			{
				file: 'e2e/native-install.spec.ts',
				line: 853,
				title: TITLE,
				error: 'Error: 409 Conflict — plan_stale: The reviewed destination changed'
			}
		]);
	});

	it('falls back to the ✘ line, dropping a minutes duration, when the log has no block', () => {
		const log = at(`  ✘   13 e2e/native-install.spec.ts:853:2 › ${TITLE} (10.0m)`);
		expect(parseListLog(log)).toEqual([
			{ file: 'e2e/native-install.spec.ts', line: 853, title: TITLE, error: '' }
		]);
	});
});

describe('parseJsonReport', () => {
	const report = {
		config: { rootDir: '/repo/apps/web/e2e', configFile: '/repo/apps/web/playwright.config.ts' },
		suites: [
			{
				title: 'ui.spec.ts',
				specs: [
					{
						title: 'passes',
						file: 'ui.spec.ts',
						line: 10,
						tests: [{ status: 'expected', results: [{ status: 'passed' }] }]
					}
				],
				suites: [
					{
						title: 'chrome',
						specs: [
							{
								title: 'stays inside',
								file: 'ui.spec.ts',
								line: 367,
								tests: [
									{
										status: 'unexpected',
										results: [{ status: 'failed', error: { message: 'TypeError: null\n  at x' } }]
									}
								]
							}
						]
					}
				]
			}
		]
	};

	it('keys failures the way the list reporter prints them', () => {
		expect(parseJsonReport(report)).toEqual([
			{
				file: 'e2e/ui.spec.ts',
				line: 367,
				title: 'chrome › stays inside',
				error: 'TypeError: null',
				status: 'unexpected'
			}
		]);
	});
});

describe('knownIssue', () => {
	const known = { [`e2e/native-install.spec.ts:853 › ${TITLE}`]: 'Tines/896' };

	it('still matches after the test moves to another line', () => {
		const moved = { file: 'e2e/native-install.spec.ts', line: 901, title: TITLE };
		expect(knownIssue(known, moved)).toBe('Tines/896');
	});

	it('does not match another test in the same file', () => {
		const other = { file: 'e2e/native-install.spec.ts', line: 853, title: 'something else' };
		expect(knownIssue(known, other)).toBeNull();
	});
});

describe('buildLedger', () => {
	const obs = (over: Partial<FlakeObservation>): FlakeObservation => ({
		file: 'e2e/a.spec.ts',
		line: 1,
		title: 'a',
		error: 'Error: boom',
		runId: 1,
		attempt: 1,
		sha: 'sha1',
		branch: 'feat/one',
		createdAt: '2026-09-20T00:00:00Z',
		...over
	});
	const reasons = (observations: FlakeObservation[], green: string[] = []) =>
		buildLedger(observations, new Set(green))[0].reasons;

	it('does not call one failure on one branch a flake', () => {
		const [row] = buildLedger([obs({})], new Set());
		expect(row).toMatchObject({ flaky: false, reasons: [], redRuns: 1, issue: null });
	});

	it('flags a failure whose SHA also went green', () => {
		expect(reasons([obs({})], ['sha1'])).toEqual(['same-sha']);
		expect(reasons([obs({})], ['another-sha'])).toEqual([]);
	});

	it('flags a failure on main', () => {
		expect(reasons([obs({ branch: 'main' })])).toEqual(['main']);
	});

	it('flags three branches, not two', () => {
		const two = [obs({}), obs({ runId: 2, branch: 'feat/two' })];
		expect(reasons(two)).toEqual([]);
		expect(reasons([...two, obs({ runId: 3, branch: 'feat/three' })])).toEqual(['branches']);
	});

	it('counts attempts as separate red runs and lists unowned flakes', () => {
		const rows = buildLedger(
			[obs({ branch: 'main' }), obs({ branch: 'main', attempt: 2, line: 9 })],
			new Set()
		);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ redRuns: 2, runs: ['1#1', '1#2'] });
		const text = renderLedger(rows, { days: 14 });
		expect(text).toContain('Flaky tests missing from known-flakes.json: 1');
		expect(text).toContain('| **none** |');
	});

	it('names the owner and leaves an owned flake out of the missing list', () => {
		const rows = buildLedger([obs({ branch: 'main' })], new Set(), {
			'e2e/a.spec.ts:1 › a': 'Tines/1'
		});
		const text = renderLedger(rows, { days: 14 });
		expect(text).toContain('| Tines/1 |');
		expect(text).toContain('Flaky tests missing from known-flakes.json: 0');
	});
});

describe('renderSummary', () => {
	const failure = { file: 'e2e/a.spec.ts', line: 1, title: 'a', error: 'Error: boom' };

	it('marks a known flake with its owner and says to re-run', () => {
		const text = renderSummary([failure], { 'e2e/a.spec.ts:1 › a': 'Tines/1' });
		expect(text).toContain('known flake → Tines/1');
		expect(text).toContain('Re-run the failed shard.');
		expect(text).not.toContain('**new failure**');
	});

	it('marks an unknown test as a new failure and says to investigate', () => {
		const text = renderSummary([failure], {});
		expect(text).toContain('| **new failure** |');
		expect(text).toContain('1 new failure. Investigate before re-running.');
	});

	it('says so when nothing failed', () => {
		expect(renderSummary([], {})).toContain('No failed tests');
	});
});

describe('known-flakes.json', () => {
	const e2e = fileURLToPath(new URL('../../e2e/', import.meta.url));
	const known: Record<string, string> = JSON.parse(readFileSync(`${e2e}known-flakes.json`, 'utf8'));

	it('maps each entry to an issue ref and to a test that still exists', () => {
		for (const [key, ref] of Object.entries(known)) {
			expect(ref, key).toMatch(/^[A-Za-z]+\/\d+$/);
			const [, file, title] = /^e2e\/(\S+?):\d+ › (.+)$/.exec(key) ?? [];
			expect(file && existsSync(e2e + file), key).toBe(true);
			// The last segment is the test's own title, as written in the spec.
			expect(readFileSync(e2e + file, 'utf8'), key).toContain(title.split(' › ').at(-1));
		}
	});
});
