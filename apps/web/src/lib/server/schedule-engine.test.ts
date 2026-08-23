import {
	compilePreset,
	describeRecurrence,
	nextOccurrenceFromCron,
	parseCron,
	renderTemplate,
	ScheduleInputError,
	templateVars,
	validateScheduleCron,
	validateTimezone
} from '@tines/shared';
import { describe, expect, it } from 'vitest';

const utc = (iso: string) => Date.parse(iso);

describe('parseCron', () => {
	it('parses stars, numbers, ranges, lists, and steps', () => {
		const parsed = parseCron('0 9-17/2 1,15 * 1-5');
		expect([...parsed.minutes]).toEqual([0]);
		expect([...parsed.hours]).toEqual([9, 11, 13, 15, 17]);
		expect([...parsed.days]).toEqual([1, 15]);
		expect(parsed.months.size).toBe(12);
		expect([...parsed.weekdays]).toEqual([1, 2, 3, 4, 5]);
	});

	it('treats 7 as Sunday in the day-of-week field', () => {
		expect([...parseCron('0 0 * * 7').weekdays]).toEqual([0]);
	});

	for (const bad of ['0 9 * *', '60 9 * * *', '0 24 * * *', '0 9 0 * *', '0 9 * 13 *', '0 9 * * 8', 'x 9 * * *', '5-1 9 * * *']) {
		it(`rejects "${bad}"`, () => {
			expect(() => parseCron(bad)).toThrow(ScheduleInputError);
		});
	}
});

describe('validateScheduleCron (sub-hourly guardrail)', () => {
	it('accepts hourly and slower schedules', () => {
		expect(() => validateScheduleCron('0 * * * *')).not.toThrow();
		expect(() => validateScheduleCron('30 9 * * 1')).not.toThrow();
	});

	for (const bad of ['* * * * *', '*/15 * * * *', '0,30 * * * *', '0-5 * * * *']) {
		it(`rejects sub-hourly "${bad}"`, () => {
			expect(() => validateScheduleCron(bad)).toThrow(/more often than once per hour/);
		});
	}
});

describe('compilePreset', () => {
	it('compiles daily/weekly/monthly to cron', () => {
		expect(compilePreset({ kind: 'daily', time: '09:00' })).toBe('0 9 * * *');
		expect(compilePreset({ kind: 'weekly', time: '09:30', weekday: 1 })).toBe('30 9 * * 1');
		expect(compilePreset({ kind: 'monthly', time: '23:05', day_of_month: 15 })).toBe('5 23 15 * *');
	});

	it('compiles hourly presets to cron', () => {
		expect(compilePreset({ kind: 'hourly', every_hours: 1 })).toBe('0 * * * *');
		expect(compilePreset({ kind: 'hourly', every_hours: 1, minute: 15 })).toBe('15 * * * *');
		expect(compilePreset({ kind: 'hourly', every_hours: 6, minute: 30 })).toBe('30 */6 * * *');
	});

	it('rejects malformed inputs', () => {
		expect(() => compilePreset({ kind: 'daily', time: '25:00' })).toThrow(ScheduleInputError);
		expect(() => compilePreset({ kind: 'weekly', time: '09:00' })).toThrow(/weekday/);
		expect(() => compilePreset({ kind: 'monthly', time: '09:00', day_of_month: 32 })).toThrow(/day_of_month/);
		expect(() => compilePreset({ kind: 'hourly' })).toThrow(/every_hours/);
		expect(() => compilePreset({ kind: 'hourly', every_hours: 0 })).toThrow(/every_hours/);
		expect(() => compilePreset({ kind: 'hourly', every_hours: 24 })).toThrow(/every_hours/);
		expect(() => compilePreset({ kind: 'hourly', every_hours: 2, minute: 60 })).toThrow(/minute/);
		expect(() => compilePreset({ kind: 'yearly', time: '09:00' } as never)).toThrow(/Unknown preset kind/);
	});
});

describe('validateTimezone', () => {
	it('accepts IANA names and rejects garbage', () => {
		expect(validateTimezone('Europe/London')).toBe('Europe/London');
		expect(() => validateTimezone('Mars/Olympus')).toThrow(ScheduleInputError);
	});
});

describe('nextOccurrence', () => {
	it('finds the next daily occurrence in UTC', () => {
		expect(nextOccurrenceFromCron('0 9 * * *', 'UTC', utc('2026-08-23T08:00:00Z'))).toBe(
			utc('2026-08-23T09:00:00Z')
		);
		expect(nextOccurrenceFromCron('0 9 * * *', 'UTC', utc('2026-08-23T09:00:00Z'))).toBe(
			utc('2026-08-24T09:00:00Z')
		);
	});

	it('evaluates in the schedule timezone', () => {
		// 09:00 in New York during DST is 13:00 UTC.
		expect(nextOccurrenceFromCron('0 9 * * *', 'America/New_York', utc('2026-08-23T00:00:00Z'))).toBe(
			utc('2026-08-23T13:00:00Z')
		);
	});

	it('handles weekly schedules (2026-08-23 is a Sunday)', () => {
		expect(nextOccurrenceFromCron('0 9 * * 1', 'UTC', utc('2026-08-23T10:00:00Z'))).toBe(
			utc('2026-08-24T09:00:00Z')
		);
	});

	it('keeps local time across a DST change', () => {
		// US DST ends 2026-11-01: New York goes from UTC-4 to UTC-5.
		expect(nextOccurrenceFromCron('0 9 * * *', 'America/New_York', utc('2026-10-31T14:00:00Z'))).toBe(
			utc('2026-11-01T14:00:00Z') // 09:00 EST
		);
	});

	it('fires a spring-forward gap time at the first valid instant', () => {
		// US DST starts 2026-03-08 02:00 EST: 02:30 does not exist; the clock
		// jumps to 03:00 EST→EDT at 07:00 UTC.
		expect(nextOccurrenceFromCron('30 2 * * *', 'America/New_York', utc('2026-03-08T00:00:00Z'))).toBe(
			utc('2026-03-08T07:00:00Z')
		);
	});

	it('fires a fall-back ambiguous time once, at the first instant', () => {
		// 2026-11-01 01:30 in New York happens at 05:30 UTC (EDT) and 06:30 UTC (EST).
		expect(nextOccurrenceFromCron('30 1 * * *', 'America/New_York', utc('2026-11-01T00:00:00Z'))).toBe(
			utc('2026-11-01T05:30:00Z')
		);
		// After the first instant has passed, the next occurrence is the next day —
		// the repeated wall time does not fire twice.
		expect(nextOccurrenceFromCron('30 1 * * *', 'America/New_York', utc('2026-11-01T05:30:00Z'))).toBe(
			utc('2026-11-02T06:30:00Z')
		);
	});

	it('skips short months for day-31 monthly schedules (cron semantics)', () => {
		expect(nextOccurrenceFromCron('0 9 31 * *', 'UTC', utc('2026-01-31T10:00:00Z'))).toBe(
			utc('2026-03-31T09:00:00Z')
		);
	});

	it('matches day-of-month OR day-of-week when both are restricted', () => {
		// Standard cron: "0 9 1 * 1" fires on the 1st and on Mondays.
		expect(nextOccurrenceFromCron('0 9 1 * 1', 'UTC', utc('2026-08-25T00:00:00Z'))).toBe(
			utc('2026-08-31T09:00:00Z') // Monday before Sep 1
		);
		expect(nextOccurrenceFromCron('0 9 1 * 1', 'UTC', utc('2026-08-31T10:00:00Z'))).toBe(
			utc('2026-09-01T09:00:00Z')
		);
	});

	it('steps every-N-hours schedules on cron boundaries (restarting at midnight)', () => {
		// 30 */6 * * * fires at 00:30, 06:30, 12:30, 18:30.
		expect(nextOccurrenceFromCron('30 */6 * * *', 'UTC', utc('2026-08-23T07:00:00Z'))).toBe(
			utc('2026-08-23T12:30:00Z')
		);
		expect(nextOccurrenceFromCron('30 */6 * * *', 'UTC', utc('2026-08-23T18:30:00Z'))).toBe(
			utc('2026-08-24T00:30:00Z')
		);
		expect(nextOccurrenceFromCron('15 * * * *', 'UTC', utc('2026-08-23T07:20:00Z'))).toBe(
			utc('2026-08-23T08:15:00Z')
		);
	});

	it('rejects impossible dates', () => {
		expect(() => nextOccurrenceFromCron('0 9 30 2 *', 'UTC', utc('2026-01-01T00:00:00Z'))).toThrow(
			/never fires/
		);
	});
});

describe('templates', () => {
	it('renders the fixed placeholder set in the schedule timezone', () => {
		const vars = templateVars('Daily triage', 14, 'Asia/Tokyo', utc('2026-08-23T00:30:00Z'));
		expect(vars).toEqual({
			date: '2026-08-23',
			time: '09:30',
			datetime: '2026-08-23 09:30',
			schedule_name: 'Daily triage',
			count: '14'
		});
		expect(renderTemplate('{{schedule_name}} {{ date }} #{{count}}', vars)).toBe(
			'Daily triage 2026-08-23 #14'
		);
	});

	it('leaves unknown or malformed tokens as-is', () => {
		const vars = templateVars('s', 1, 'UTC', 0);
		expect(renderTemplate('{{oops}} {{date} {{}} {{date}}', vars)).toBe('{{oops}} {{date} {{}} 1970-01-01');
	});
});

describe('describeRecurrence', () => {
	it('describes presets and raw cron', () => {
		expect(describeRecurrence({ kind: 'weekly', time: '09:00', weekday: 1 }, '0 9 * * 1')).toBe(
			'Every Monday at 09:00'
		);
		expect(describeRecurrence({ kind: 'hourly', every_hours: 1 }, '0 * * * *')).toBe('Every hour');
		expect(describeRecurrence({ kind: 'hourly', every_hours: 1, minute: 5 }, '5 * * * *')).toBe(
			'Every hour at :05'
		);
		expect(describeRecurrence({ kind: 'hourly', every_hours: 6, minute: 30 }, '30 */6 * * *')).toBe(
			'Every 6 hours at :30'
		);
		expect(describeRecurrence(null, '0 9 * * 1')).toBe('Cron “0 9 * * 1”');
	});
});
