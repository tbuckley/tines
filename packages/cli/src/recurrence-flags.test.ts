import { describeRecurrence } from '@tines/shared';
import { describe, expect, it } from 'vitest';
import { buildRecurrence, parseWeekday } from './recurrence-flags.js';

describe('parseWeekday', () => {
	it.each([
		['sunday', 0],
		['mon', 1],
		['Tue', 2],
		['WEDNESDAY', 3],
		['0', 0],
		['6', 6],
		// cron treats both 0 and 7 as Sunday.
		['7', 0]
	])('parses %j as %i', (value, expected) => {
		expect(parseWeekday(value)).toBe(expected);
	});

	it('rejects a number out of range', () => {
		expect(() => parseWeekday('8')).toThrow('--on weekday must be 0-7 or a name, got "8"');
	});

	it.each(['funday', 'mo'])('rejects %j', (value) => {
		expect(() => parseWeekday(value)).toThrow(`unknown weekday "${value}"`);
	});
});

describe('buildRecurrence', () => {
	it('returns undefined when no recurrence flags are given', () => {
		expect(buildRecurrence({})).toBeUndefined();
	});

	it('passes --cron through raw', () => {
		expect(buildRecurrence({ cron: '*/5 * * * *' })).toEqual({ cron: '*/5 * * * *' });
	});

	it.each([
		[{ every: 'hourly' }, { kind: 'hourly', every_hours: 1, minute: 0 }],
		[{ every: '6h' }, { kind: 'hourly', every_hours: 6, minute: 0 }],
		[
			{ every: '2h', at: ':15' },
			{ kind: 'hourly', every_hours: 2, minute: 15 }
		],
		// For hourly, --at is bare minutes too.
		[
			{ every: '2h', at: '15' },
			{ kind: 'hourly', every_hours: 2, minute: 15 }
		],
		[{ every: 'daily' }, { kind: 'daily', time: '09:00' }],
		[
			{ every: 'daily', at: '18:30' },
			{ kind: 'daily', time: '18:30' }
		],
		[
			{ every: 'weekly', on: 'tue' },
			{ kind: 'weekly', time: '09:00', weekday: 2 }
		],
		[
			{ every: 'weekly', on: 'friday', at: '17:00' },
			{ kind: 'weekly', time: '17:00', weekday: 5 }
		],
		[
			{ every: 'monthly', on: '1' },
			{ kind: 'monthly', time: '09:00', day_of_month: 1 }
		],
		[
			{ every: 'monthly', on: '31', at: '23:59' },
			{ kind: 'monthly', time: '23:59', day_of_month: 31 }
		]
	])('builds %o', (opts, preset) => {
		expect(buildRecurrence(opts)).toEqual({ preset });
	});

	// The point of the preset shape is that the server and both UIs can describe
	// it back. Round-tripping through describeRecurrence proves the flags mean
	// what the help text claims.
	it.each([
		[{ every: 'hourly' }, 'Every hour'],
		[{ every: '6h' }, 'Every 6 hours'],
		[{ every: 'daily', at: '18:30' }, 'Every day at 18:30'],
		[{ every: 'weekly', on: 'tue', at: '09:30' }, 'Every Tuesday at 09:30'],
		[{ every: 'monthly', on: '3' }, 'Monthly on day 3 at 09:00']
	])('%o round-trips to %j', (opts, prose) => {
		const built = buildRecurrence(opts)!;
		expect(describeRecurrence(built.preset ?? null, built.cron ?? '')).toBe(prose);
	});

	it.each([
		[{ cron: '* * * * *', every: 'daily' }, 'pass --cron or --every/--at/--on, not both'],
		[{ at: '09:00' }, '--at/--on set a preset time; add --every <hourly|Nh|daily|weekly|monthly>'],
		[{ every: 'hourly', on: 'tue' }, 'an hourly recurrence does not take --on'],
		[{ every: '0h' }, '--every <N>h needs N between 1 and 23, got "0h"'],
		[{ every: '24h' }, '--every <N>h needs N between 1 and 23, got "24h"'],
		[{ every: '2h', at: '60' }, 'with an hourly recurrence, --at is the minute past the hour'],
		[{ every: '2h', at: '09:30' }, 'with an hourly recurrence, --at is the minute past the hour'],
		[{ every: 'daily', on: 'tue' }, '--every daily does not take --on'],
		[{ every: 'weekly' }, '--every weekly needs --on <weekday>'],
		[{ every: 'monthly' }, '--every monthly needs --on <day-of-month>'],
		[{ every: 'monthly', on: '0' }, '--on day-of-month must be 1-31, got "0"'],
		[{ every: 'monthly', on: '32' }, '--on day-of-month must be 1-31, got "32"'],
		[{ every: 'monthly', on: 'tue' }, '--on day-of-month must be 1-31, got "tue"'],
		[
			{ every: 'fortnightly' },
			'--every must be hourly, <N>h, daily, weekly, or monthly, got "fortnightly"'
		]
	])('rejects %o', (opts, message) => {
		expect(() => buildRecurrence(opts)).toThrow(message);
	});
});
