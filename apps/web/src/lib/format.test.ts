import { describe, expect, it } from 'vitest';
import { nextRunLabel, relativeTimeShort, truncate, untilTime } from './format';

describe('truncate', () => {
	it('leaves short values alone', () => {
		expect(truncate('QA Playground', 60)).toBe('QA Playground');
	});

	it('never exceeds the limit, ellipsis included', () => {
		const clamped = truncate('x'.repeat(200), 60);
		expect(clamped).toHaveLength(60);
		expect(clamped.endsWith('…')).toBe(true);
	});

	it('keeps a value of exactly the limit intact', () => {
		expect(truncate('x'.repeat(60), 60)).toBe('x'.repeat(60));
	});
});

/** Fixed clock: every case below is a distance from this instant. */
const NOW = Date.UTC(2026, 5, 15, 12, 0, 0);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe('relativeTimeShort', () => {
	it('phrases the recent past as a bare duration', () => {
		expect(relativeTimeShort(NOW - 30_000, NOW)).toBe('now');
		expect(relativeTimeShort(NOW - 5 * MINUTE, NOW)).toBe('5m');
		expect(relativeTimeShort(NOW - 3 * HOUR, NOW)).toBe('3h');
		expect(relativeTimeShort(NOW - 2 * DAY, NOW)).toBe('2d');
		expect(relativeTimeShort(NOW - 29 * DAY, NOW)).toBe('29d');
	});

	it('falls back to the day within the year, and to the year beyond it', () => {
		const thisYear = NOW - 40 * DAY;
		expect(relativeTimeShort(thisYear, NOW)).toBe(
			new Date(thisYear).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
		);
		const lastYear = NOW - 400 * DAY;
		expect(relativeTimeShort(lastYear, NOW)).toBe(
			new Date(lastYear).toLocaleDateString(undefined, { month: 'short', year: 'numeric' })
		);
	});
});

describe('untilTime', () => {
	it('counts down to a future timestamp', () => {
		expect(untilTime(NOW + 30_000, NOW)).toBe('in <1m');
		expect(untilTime(NOW + 5 * MINUTE, NOW)).toBe('in 5m');
		expect(untilTime(NOW + 3 * HOUR, NOW)).toBe('in 3h');
		expect(untilTime(NOW + 2 * DAY, NOW)).toBe('in 2d');
	});

	it('falls back to an absolute date beyond a month out', () => {
		const far = NOW + 400 * DAY;
		expect(untilTime(far, NOW)).toBe(
			new Date(far).toLocaleDateString(undefined, {
				month: 'short',
				day: 'numeric',
				year: 'numeric'
			})
		);
	});

	it('reads a past timestamp as overdue rather than an imminent countdown', () => {
		// The bug: every one of these used to fall into `diff < 60_000` and
		// render "in <1m", so a stalled sweep looked perpetually healthy.
		expect(untilTime(NOW - 5 * MINUTE, NOW)).toBe('5m overdue');
		expect(untilTime(NOW - 3 * HOUR, NOW)).toBe('3h overdue');
		expect(untilTime(NOW - 2 * DAY, NOW)).toBe('2d overdue');
		expect(untilTime(NOW - 365 * DAY, NOW)).toBe(
			`overdue since ${new Date(NOW - 365 * DAY).toLocaleDateString(undefined, {
				month: 'short',
				day: 'numeric',
				year: 'numeric'
			})}`
		);
	});

	it('treats the minute either side of the due time as due, not late', () => {
		// The sweep only fires every few minutes, so seconds of lateness is
		// routine and must not read as a fault.
		expect(untilTime(NOW, NOW)).toBe('in <1m');
		expect(untilTime(NOW - 1, NOW)).toBe('due now');
		expect(untilTime(NOW - 59_999, NOW)).toBe('due now');
		expect(untilTime(NOW - MINUTE, NOW)).toBe('1m overdue');
	});

	it('never claims a past timestamp is in the future', () => {
		for (const late of [1, 30_000, MINUTE, 47 * MINUTE, 5 * HOUR, 9 * DAY, 900 * DAY]) {
			expect(untilTime(NOW - late, NOW)).not.toMatch(/^in /);
		}
	});
});

describe('nextRunLabel', () => {
	it('prefixes a pending run with "next"', () => {
		expect(nextRunLabel(NOW + 5 * MINUTE, NOW)).toBe('next in 5m');
		expect(nextRunLabel(NOW + 30_000, NOW)).toBe('next in <1m');
		expect(nextRunLabel(NOW, NOW)).toBe('next in <1m');
	});

	it('drops the prefix once past due, since "next 3h overdue" reads backwards', () => {
		expect(nextRunLabel(NOW - 1, NOW)).toBe('due now');
		expect(nextRunLabel(NOW - 3 * HOUR, NOW)).toBe('3h overdue');
	});
});
