/**
 * Schedule recurrences in packs (`schedules/<name>.yaml`), compiled the way
 * `tines issues create --every/--at/--on/--cron` compiles its flags
 * (packages/cli/src/recurrence-flags.ts, `buildRecurrence`).
 */
import {
	compilePreset,
	ScheduleInputError,
	validateScheduleCron,
	WEEKDAY_NAMES,
	type SchedulePreset
} from '../schedule.js';
import type { CompiledRecurrence, PackRecurrence } from './types.js';

function parseWeekday(value: string | number): number {
	const trimmed = String(value).trim().toLowerCase();
	if (/^\d+$/.test(trimmed)) {
		const n = Number.parseInt(trimmed, 10);
		if (n <= 7) return n % 7; // 0 and 7 both mean Sunday, as in cron
		throw new ScheduleInputError(`"on" weekday must be 0-7 or a name, got "${value}"`);
	}
	if (trimmed.length >= 3) {
		const idx = WEEKDAY_NAMES.findIndex((w) => w.toLowerCase().startsWith(trimmed));
		if (idx !== -1) return idx;
	}
	throw new ScheduleInputError(
		`unknown weekday "${value}" (use e.g. monday, tue, or 0-6 with 0 = Sunday)`
	);
}

/**
 * Compiles a pack recurrence to the schedules API's `{ preset }` or
 * `{ cron }`, and validates it (`compilePreset` / `validateScheduleCron`).
 * Throws `ScheduleInputError` when it is invalid.
 *
 * - `{ cron }`: a 5-field cron firing at most hourly.
 * - `every: hourly | <N>h`: `at` is the minute past the hour (`15` or `:15`,
 *   default 0); no `on`.
 * - `every: daily`: `at` is `HH:MM` (default `09:00`); no `on`.
 * - `every: weekly`: `on` is a weekday name (3+ letters) or 0-7.
 * - `every: monthly`: `on` is a day of month 1-31.
 */
export function compilePackRecurrence(r: PackRecurrence): CompiledRecurrence {
	if ('cron' in r) {
		if (typeof r.cron !== 'string') throw new ScheduleInputError('"cron" must be a string');
		validateScheduleCron(r.cron);
		return { cron: r.cron };
	}
	const { every, on, at } = r;
	if (typeof every !== 'string') {
		throw new ScheduleInputError(
			'A recurrence needs "every" (hourly, <N>h, daily, weekly, monthly) or "cron"'
		);
	}
	if (at !== undefined && typeof at !== 'string') {
		throw new ScheduleInputError('"at" must be a string');
	}
	let preset: SchedulePreset;
	const hourly = every === 'hourly' ? '1' : every.match(/^(\d+)h$/)?.[1];
	if (hourly !== undefined) {
		if (on !== undefined) throw new ScheduleInputError('an hourly recurrence does not take "on"');
		const everyHours = Number.parseInt(hourly, 10);
		if (everyHours < 1 || everyHours > 23) {
			throw new ScheduleInputError(`"every: <N>h" needs N between 1 and 23, got "${every}"`);
		}
		let minute = 0;
		if (at !== undefined) {
			const m = at.match(/^:?(\d{1,2})$/);
			if (!m || Number.parseInt(m[1], 10) > 59) {
				throw new ScheduleInputError(
					`with an hourly recurrence, "at" is the minute past the hour (0-59 or :MM), got "${at}"`
				);
			}
			minute = Number.parseInt(m[1], 10);
		}
		preset = { kind: 'hourly', every_hours: everyHours, minute };
	} else {
		const time = at ?? '09:00';
		switch (every) {
			case 'daily':
				if (on !== undefined) throw new ScheduleInputError('"every: daily" does not take "on"');
				preset = { kind: 'daily', time };
				break;
			case 'weekly':
				if (on === undefined) throw new ScheduleInputError('"every: weekly" needs "on: <weekday>"');
				preset = { kind: 'weekly', time, weekday: parseWeekday(on) };
				break;
			case 'monthly': {
				if (on === undefined) {
					throw new ScheduleInputError('"every: monthly" needs "on: <day-of-month>"');
				}
				const text = String(on).trim();
				const day = Number.parseInt(text, 10);
				if (!/^\d+$/.test(text) || day < 1 || day > 31) {
					throw new ScheduleInputError(`"on" day-of-month must be 1-31, got "${on}"`);
				}
				preset = { kind: 'monthly', time, day_of_month: day };
				break;
			}
			default:
				throw new ScheduleInputError(
					`"every" must be hourly, <N>h, daily, weekly, or monthly, got "${every}"`
				);
		}
	}
	compilePreset(preset);
	return { preset };
}
