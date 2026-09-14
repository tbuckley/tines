import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ execFileSync: vi.fn() }));

vi.mock('node:child_process', () => ({ execFileSync: mocks.execFileSync }));

import { d1 } from '../e2e/d1';

const WEB_DIR = fileURLToPath(new URL('..', import.meta.url));
const SQL = 'UPDATE probe SET value = value + 1; SELECT value FROM probe;';
const SUCCESS = JSON.stringify([{ success: true, results: [{ value: 1 }] }]);

function processError(
	message: string,
	diagnostics: Record<string, unknown> & {
		stdout?: string | Buffer | object;
		stderr?: string | Buffer | object;
	} = {}
) {
	return Object.assign(new Error(message), diagnostics);
}

describe('E2E D1 helper', () => {
	beforeEach(() => {
		mocks.execFileSync.mockReset();
		vi.spyOn(Atomics, 'wait').mockReturnValue('timed-out');
	});

	afterEach(() => vi.restoreAllMocks());

	it('preserves the local command, cwd, statement order, and missing results fallback', () => {
		mocks.execFileSync.mockReturnValue(
			JSON.stringify([
				{ success: true, results: [{ position: 1 }] },
				{ success: true, results: [{ position: 2 }] },
				{ success: true }
			])
		);

		expect(d1<{ position: number }>(SQL)).toEqual([{ position: 1 }, { position: 2 }]);
		expect(mocks.execFileSync).toHaveBeenCalledOnce();
		expect(mocks.execFileSync).toHaveBeenCalledWith(
			'pnpm',
			[
				'exec',
				'wrangler',
				'd1',
				'execute',
				'tines',
				'--local',
				'--persist-to',
				'.wrangler-e2e',
				'--json',
				'--command',
				SQL
			],
			{ cwd: WEB_DIR, encoding: 'utf8' }
		);
		expect(Atomics.wait).not.toHaveBeenCalled();
	});

	it.each([
		['string stderr', { stderr: 'database is locked' }],
		['Buffer stderr', { stderr: Buffer.from('NOSENTRY SQLITE_BUSY_TIMEOUT') }],
		['string stdout', { stdout: 'Database Is Locked' }],
		['Buffer stdout', { stdout: Buffer.from('SQLITE_BUSY') }]
	])('retries lock diagnostics from %s', (_label, diagnostics) => {
		mocks.execFileSync
			.mockImplementationOnce(() => {
				throw processError('wrangler failed', diagnostics);
			})
			.mockReturnValueOnce(SUCCESS);

		expect(d1<{ value: number }>(SQL)).toEqual([{ value: 1 }]);
		expect(mocks.execFileSync).toHaveBeenCalledTimes(2);
		expect(Atomics.wait).toHaveBeenCalledOnce();
		expect(Atomics.wait).toHaveBeenCalledWith(expect.any(Int32Array), 0, 0, 50);
	});

	it('replays the identical whole command with exponential waits until recovery', () => {
		mocks.execFileSync
			.mockImplementationOnce(() => {
				throw processError('first lock', { stderr: 'SQLITE_BUSY' });
			})
			.mockImplementationOnce(() => {
				throw processError('second lock', { stderr: 'database is locked' });
			})
			.mockReturnValueOnce(SUCCESS);

		expect(d1<{ value: number }>(SQL)).toEqual([{ value: 1 }]);
		expect(mocks.execFileSync).toHaveBeenCalledTimes(3);
		expect(mocks.execFileSync.mock.calls[1]).toEqual(mocks.execFileSync.mock.calls[0]);
		expect(mocks.execFileSync.mock.calls[2]).toEqual(mocks.execFileSync.mock.calls[0]);
		expect(vi.mocked(Atomics.wait).mock.calls.map((call) => call[3])).toEqual([50, 100]);
	});

	it('rethrows the sixth lock error unchanged after five waits', () => {
		const errors = Array.from({ length: 6 }, (_, index) =>
			processError(`lock ${index + 1}`, { stderr: 'SQLITE_BUSY' })
		);
		for (const error of errors) {
			mocks.execFileSync.mockImplementationOnce(() => {
				throw error;
			});
		}

		let thrown: unknown;
		try {
			d1(SQL);
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBe(errors[5]);
		expect(mocks.execFileSync).toHaveBeenCalledTimes(6);
		expect(vi.mocked(Atomics.wait).mock.calls.map((call) => call[3])).toEqual([
			50, 100, 200, 400, 800
		]);
	});

	it('stops immediately when a permanent error follows a lock', () => {
		const permanent = processError('permanent', { stderr: 'no such table: probe: SQLITE_ERROR' });
		mocks.execFileSync
			.mockImplementationOnce(() => {
				throw processError('busy', { stderr: 'SQLITE_BUSY' });
			})
			.mockImplementationOnce(() => {
				throw permanent;
			});

		expect(() => d1(SQL)).toThrow(permanent);
		expect(mocks.execFileSync).toHaveBeenCalledTimes(2);
		expect(Atomics.wait).toHaveBeenCalledOnce();
	});

	it.each([
		['missing table', processError('failed', { stderr: 'no such table: probe: SQLITE_ERROR' })],
		['syntax error', processError('failed', { stderr: 'near nope: syntax error' })],
		['constraint error', processError('failed', { stderr: 'UNIQUE constraint failed' })],
		['missing executable', processError('spawnSync pnpm ENOENT')],
		['missing configuration', processError('failed', { stderr: 'No D1 database found' })],
		['generic D1 error', processError('failed', { stderr: 'D1_ERROR: internal error' })],
		['signal error', processError('terminated', { stderr: '', stdout: '', signal: 'SIGTERM' })],
		[
			'lock words only in the echoed message',
			processError('command contained SELECT "SQLITE_BUSY"', { stderr: 'no such table: probe' })
		],
		['unsupported diagnostics', processError('failed', { stderr: { reason: 'SQLITE_BUSY' } })]
	])('does not retry a permanent process failure: %s', (_label, error) => {
		mocks.execFileSync.mockImplementationOnce(() => {
			throw error;
		});

		expect(() => d1(SQL)).toThrow(error);
		expect(mocks.execFileSync).toHaveBeenCalledOnce();
		expect(Atomics.wait).not.toHaveBeenCalled();
	});

	it('does not retry malformed JSON output', () => {
		mocks.execFileSync.mockReturnValue('not json');

		expect(() => d1(SQL)).toThrow(SyntaxError);
		expect(mocks.execFileSync).toHaveBeenCalledOnce();
		expect(Atomics.wait).not.toHaveBeenCalled();
	});

	it('does not retry unsuccessful statement output', () => {
		const raw = JSON.stringify([{ success: false, results: [] }]);
		mocks.execFileSync.mockReturnValue(raw);

		expect(() => d1(SQL)).toThrow(raw);
		expect(mocks.execFileSync).toHaveBeenCalledOnce();
		expect(Atomics.wait).not.toHaveBeenCalled();
	});

	it('does not treat lock words in successful results as contention', () => {
		mocks.execFileSync.mockReturnValue(
			JSON.stringify([
				{ success: true, results: [{ diagnostic: 'database is locked: SQLITE_BUSY' }] }
			])
		);

		expect(d1<{ diagnostic: string }>(SQL)).toEqual([
			{ diagnostic: 'database is locked: SQLITE_BUSY' }
		]);
		expect(mocks.execFileSync).toHaveBeenCalledOnce();
		expect(Atomics.wait).not.toHaveBeenCalled();
	});
});
