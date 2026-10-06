import { describe, expect, it } from 'vitest';
import { ScheduleInputError } from '../schedule.js';
import { compilePackRecurrence } from './recurrence.js';
import type { PackRecurrence } from './types.js';

describe('compilePackRecurrence', () => {
	it.each<[PackRecurrence, unknown]>([
		[{ every: 'hourly' }, { preset: { kind: 'hourly', every_hours: 1, minute: 0 } }],
		[{ every: 'hourly', at: ':15' }, { preset: { kind: 'hourly', every_hours: 1, minute: 15 } }],
		[{ every: '4h', at: '30' }, { preset: { kind: 'hourly', every_hours: 4, minute: 30 } }],
		[{ every: 'daily' }, { preset: { kind: 'daily', time: '09:00' } }],
		[{ every: 'daily', at: '17:45' }, { preset: { kind: 'daily', time: '17:45' } }],
		[
			{ every: 'weekly', on: 'mon', at: '09:00' },
			{ preset: { kind: 'weekly', time: '09:00', weekday: 1 } }
		],
		[{ every: 'weekly', on: 'Friday' }, { preset: { kind: 'weekly', time: '09:00', weekday: 5 } }],
		[{ every: 'weekly', on: 7 }, { preset: { kind: 'weekly', time: '09:00', weekday: 0 } }],
		[
			{ every: 'monthly', on: 15, at: '08:00' },
			{ preset: { kind: 'monthly', time: '08:00', day_of_month: 15 } }
		],
		[
			{ every: 'monthly', on: '1' },
			{ preset: { kind: 'monthly', time: '09:00', day_of_month: 1 } }
		],
		[{ cron: '0 9 * * 1' }, { cron: '0 9 * * 1' }]
	])('compiles %j', (r, expected) => {
		expect(compilePackRecurrence(r)).toEqual(expected);
	});

	it.each<PackRecurrence>([
		{ every: 'hourly', on: 'mon' },
		{ every: '24h' },
		{ every: '0h' },
		{ every: 'hourly', at: '61' },
		{ every: 'daily', on: 'mon' },
		{ every: 'daily', at: '25:00' },
		{ every: 'weekly' },
		{ every: 'weekly', on: 'mo' },
		{ every: 'weekly', on: 8 },
		{ every: 'monthly' },
		{ every: 'monthly', on: 32 },
		{ every: 'fortnightly' as 'daily' },
		{ cron: '* * * * *' },
		{ cron: '0 9 * *' }
	])('rejects %j', (r) => {
		expect(() => compilePackRecurrence(r)).toThrow(ScheduleInputError);
	});
});
