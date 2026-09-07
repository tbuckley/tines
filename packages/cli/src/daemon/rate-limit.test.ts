import { describe, expect, it } from 'vitest';
import {
	parseResetTime,
	RateLimitDetector,
	rateLimitFromStderrLine,
	rateLimitFromStreamEvent,
	USAGE_LIMIT_PREFIXES
} from './rate-limit';

// 2026-09-06T18:36:00Z — 2:36pm in New York, inside daylight time.
const NOW = Date.parse('2026-09-06T18:36:00.000Z');

describe('rateLimitFromStreamEvent', () => {
	it('reads a rejected limit, its window and its reset', () => {
		const signal = rateLimitFromStreamEvent({
			type: 'rate_limit_event',
			rate_limit_info: {
				status: 'rejected',
				resetsAt: 1_788_739_200,
				rateLimitType: 'five_hour'
			}
		});
		expect(signal).toMatchObject({
			source: 'stream',
			limit: 'five_hour',
			resumeAt: 1_788_739_200_000
		});
		expect(signal?.detail).toContain('five_hour');
	});

	it('takes a resetsAt that is already milliseconds at face value', () => {
		expect(
			rateLimitFromStreamEvent({
				type: 'rate_limit_event',
				rate_limit_info: { status: 'rejected', resetsAt: 1_788_739_200_000 }
			})?.resumeAt
		).toBe(1_788_739_200_000);
	});

	it('ignores an allowed limit, another event type and junk', () => {
		expect(
			rateLimitFromStreamEvent({
				type: 'rate_limit_event',
				rate_limit_info: { status: 'allowed', resetsAt: 1_788_739_200 }
			})
		).toBeNull();
		expect(rateLimitFromStreamEvent({ type: 'assistant' })).toBeNull();
		expect(rateLimitFromStreamEvent({ type: 'rate_limit_event' })).toBeNull();
		expect(rateLimitFromStreamEvent(null)).toBeNull();
		expect(rateLimitFromStreamEvent('rate_limit_event')).toBeNull();
	});

	it('survives a rejection with no reset time', () => {
		expect(
			rateLimitFromStreamEvent({
				type: 'rate_limit_event',
				rate_limit_info: { status: 'rejected' }
			})
		).toMatchObject({ resumeAt: null, limit: null });
	});
});

describe('rateLimitFromStderrLine', () => {
	it('matches the line the harness actually printed, and parses its reset', () => {
		const signal = rateLimitFromStderrLine(
			"You've hit your session limit · resets 3pm (America/New_York)",
			NOW
		);
		expect(signal?.source).toBe('stderr');
		expect(signal?.limit).toBeNull();
		expect(signal?.resumeAt).toBe(Date.parse('2026-09-06T19:00:00.000Z'));
	});

	it('matches through ANSI colouring and surrounding whitespace', () => {
		expect(
			rateLimitFromStderrLine("  \x1b[31mYou've reached your usage limit\x1b[0m  ", NOW)
		).not.toBeNull();
	});

	it('matches every prefix the harness classifies as a usage limit', () => {
		for (const prefix of USAGE_LIMIT_PREFIXES) {
			expect(rateLimitFromStderrLine(`${prefix} whatever follows`, NOW), prefix).not.toBeNull();
		}
		expect(
			rateLimitFromStderrLine('Fable 5.1 requires usage credits. Add some.', NOW)
		).not.toBeNull();
	});

	it('does not match ordinary harness noise or a near miss', () => {
		expect(rateLimitFromStderrLine("You've hit a snag; retrying", NOW)).toBeNull();
		expect(rateLimitFromStderrLine('API Error: 529 Overloaded', NOW)).toBeNull();
		expect(rateLimitFromStderrLine('', NOW)).toBeNull();
	});

	it('still signals when the reset time is missing or unparseable', () => {
		expect(rateLimitFromStderrLine("You've hit your session limit", NOW)).toMatchObject({
			resumeAt: null
		});
		expect(
			rateLimitFromStderrLine("You've hit your weekly limit · resets later", NOW)?.resumeAt
		).toBeNull();
	});
});

describe('parseResetTime', () => {
	it('takes the next occurrence of a bare wall-clock time in the named zone', () => {
		// 3pm New York is still ahead of 2:36pm: today.
		expect(parseResetTime('3pm (America/New_York)', NOW)).toBe(
			Date.parse('2026-09-06T19:00:00.000Z')
		);
		// 9:30am has passed: tomorrow.
		expect(parseResetTime('9:30am (America/New_York)', NOW)).toBe(
			Date.parse('2026-09-07T13:30:00.000Z')
		);
	});

	it('handles a minute-precision evening time', () => {
		expect(parseResetTime('9:30pm (America/New_York)', NOW)).toBe(
			Date.parse('2026-09-07T01:30:00.000Z')
		);
	});

	it('reads a dated reset, with and without a year', () => {
		expect(parseResetTime('Sep 8, 3pm (America/New_York)', NOW)).toBe(
			Date.parse('2026-09-08T19:00:00.000Z')
		);
		expect(parseResetTime('Sep 8, 2027, 3pm (America/New_York)', NOW)).toBe(
			Date.parse('2027-09-08T19:00:00.000Z')
		);
	});

	it('rolls a bare date that already passed into next year', () => {
		// Asked on Sep 6 2026, "Jan 2, 3pm" can only mean 2027.
		expect(parseResetTime('Jan 2, 3pm (America/New_York)', NOW)).toBe(
			Date.parse('2027-01-02T20:00:00.000Z')
		);
	});

	it('applies the offset in force at the reset, not at now (DST boundary)', () => {
		// US clocks fall back at 2am on 2026-11-01: 3pm that day is EST (-5),
		// while `now` two days earlier is still EDT (-4).
		const beforeFallBack = Date.parse('2026-10-30T18:36:00.000Z');
		expect(parseResetTime('Nov 1, 3pm (America/New_York)', beforeFallBack)).toBe(
			Date.parse('2026-11-01T20:00:00.000Z')
		);
	});

	it('reads a relative duration', () => {
		expect(parseResetTime('in 2h 15m', NOW)).toBe(NOW + 2 * 3_600_000 + 15 * 60_000);
		expect(parseResetTime('in 45m', NOW)).toBe(NOW + 45 * 60_000);
		expect(parseResetTime('in 3d 2h', NOW)).toBe(NOW + 3 * 86_400_000 + 2 * 3_600_000);
	});

	it('gives up rather than guessing', () => {
		expect(parseResetTime('later', NOW)).toBeNull();
		expect(parseResetTime('3pm', NOW)).toBeNull(); // no zone: the time means nothing
		expect(parseResetTime('3pm (Mars/Olympus_Mons)', NOW)).toBeNull();
		expect(parseResetTime('', NOW)).toBeNull();
		expect(parseResetTime('in a while', NOW)).toBeNull();
	});
});

describe('RateLimitDetector', () => {
	it('has nothing to say about an ordinary run', () => {
		const d = new RateLimitDetector();
		d.noteStreamEvent({ type: 'assistant' });
		d.noteStderr('warning: something\n', NOW);
		d.finish(NOW);
		expect(d.signal()).toBeNull();
	});

	it('joins a line split across stderr chunks', () => {
		const d = new RateLimitDetector();
		d.noteStderr("You've hit your session lim", NOW);
		d.noteStderr('it · resets 3pm (America/New_York)\n', NOW);
		expect(d.signal()?.resumeAt).toBe(Date.parse('2026-09-06T19:00:00.000Z'));
	});

	it('flushes a trailing line with no newline only on finish', () => {
		const d = new RateLimitDetector();
		d.noteStderr("You've hit your session limit", NOW);
		expect(d.signal()).toBeNull();
		d.finish(NOW);
		expect(d.signal()).not.toBeNull();
	});

	it('prefers the structured stream over the prose, whichever arrived first', () => {
		const d = new RateLimitDetector();
		d.noteStderr("You've hit your session limit · resets 3pm (America/New_York)\n", NOW);
		d.noteStreamEvent({
			type: 'rate_limit_event',
			rate_limit_info: { status: 'rejected', resetsAt: 1_788_739_200, rateLimitType: 'five_hour' }
		});
		expect(d.signal()?.source).toBe('stream');
	});

	it('keeps the last rejection: a later one carries the later reset', () => {
		const d = new RateLimitDetector();
		d.noteStreamEvent({
			type: 'rate_limit_event',
			rate_limit_info: { status: 'rejected', resetsAt: 1000 }
		});
		d.noteStreamEvent({
			type: 'rate_limit_event',
			rate_limit_info: { status: 'rejected', resetsAt: 2000 }
		});
		expect(d.signal()?.resumeAt).toBe(2_000_000);
	});
});
