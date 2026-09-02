/**
 * `--every/--at/--on` are the human-facing half of a schedule: they build the
 * structured `preset` the server stores. `--cron` is the raw escape hatch and
 * is mutually exclusive with them. `describeRecurrence` in @tines/shared turns
 * the result back into prose, and the tests round-trip through it.
 */
import { type CreateScheduleInput, WEEKDAY_NAMES } from '@tines/shared';
import { CliError } from './errors.js';

export interface RecurrenceOpts {
	every?: string;
	at?: string;
	on?: string;
	cron?: string;
	tz?: string;
}

export function parseWeekday(value: string): number {
	const trimmed = value.trim().toLowerCase();
	if (/^\d+$/.test(trimmed)) {
		const n = Number.parseInt(trimmed, 10);
		if (n <= 7) return n % 7; // 0 and 7 both mean Sunday, as in cron
		throw new CliError(`--on weekday must be 0-7 or a name, got "${value}"`);
	}
	if (trimmed.length >= 3) {
		const idx = WEEKDAY_NAMES.findIndex((w) => w.toLowerCase().startsWith(trimmed));
		if (idx !== -1) return idx;
	}
	throw new CliError(`unknown weekday "${value}" (use e.g. monday, tue, or 0-6 with 0 = Sunday)`);
}

/** The preset/cron half of a schedule input, or undefined when no flags given. */
export function buildRecurrence(
	opts: RecurrenceOpts
): Pick<CreateScheduleInput, 'preset' | 'cron'> | undefined {
	const hasPresetFlags = opts.every !== undefined || opts.at !== undefined || opts.on !== undefined;
	if (opts.cron !== undefined && hasPresetFlags) {
		throw new CliError('pass --cron or --every/--at/--on, not both');
	}
	if (opts.cron !== undefined) return { cron: opts.cron };
	if (!hasPresetFlags) return undefined;
	if (opts.every === undefined) {
		throw new CliError('--at/--on set a preset time; add --every <hourly|Nh|daily|weekly|monthly>');
	}
	const hourly = opts.every === 'hourly' ? 1 : opts.every.match(/^(\d+)h$/)?.[1];
	if (hourly !== undefined) {
		if (opts.on !== undefined) throw new CliError('an hourly recurrence does not take --on');
		const every = typeof hourly === 'number' ? hourly : Number.parseInt(hourly, 10);
		if (every < 1 || every > 23)
			throw new CliError(`--every <N>h needs N between 1 and 23, got "${opts.every}"`);
		// For hourly, --at is the minute past the hour (":15" or "15").
		let minute = 0;
		if (opts.at !== undefined) {
			const m = opts.at.match(/^:?(\d{1,2})$/);
			if (!m || Number.parseInt(m[1], 10) > 59) {
				throw new CliError(
					`with an hourly recurrence, --at is the minute past the hour (0-59 or :MM), got "${opts.at}"`
				);
			}
			minute = Number.parseInt(m[1], 10);
		}
		return { preset: { kind: 'hourly', every_hours: every, minute } };
	}
	const time = opts.at ?? '09:00';
	switch (opts.every) {
		case 'daily': {
			if (opts.on !== undefined) throw new CliError('--every daily does not take --on');
			return { preset: { kind: 'daily', time } };
		}
		case 'weekly': {
			if (opts.on === undefined) throw new CliError('--every weekly needs --on <weekday>');
			return { preset: { kind: 'weekly', time, weekday: parseWeekday(opts.on) } };
		}
		case 'monthly': {
			if (opts.on === undefined) throw new CliError('--every monthly needs --on <day-of-month>');
			const day = Number.parseInt(opts.on, 10);
			if (!/^\d+$/.test(opts.on.trim()) || day < 1 || day > 31) {
				throw new CliError(`--on day-of-month must be 1-31, got "${opts.on}"`);
			}
			return { preset: { kind: 'monthly', time, day_of_month: day } };
		}
		default:
			throw new CliError(
				`--every must be hourly, <N>h, daily, weekly, or monthly, got "${opts.every}"`
			);
	}
}
