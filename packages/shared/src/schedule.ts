/**
 * Recurrence engine for scheduled tasks: 5-field cron parsing, preset
 * compilation, next-occurrence computation in an IANA timezone, and template
 * placeholder rendering. Pure and dependency-free so the server (sweep +
 * validation), the web UI (live summary) and the CLI all share one
 * implementation. See specs/scheduled_tasks/SPEC.md.
 */

/** Thrown for invalid recurrences/timezones; the API maps it to a 422. */
export class ScheduleInputError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'ScheduleInputError';
	}
}

// ---------------------------------------------------------------------------
// Cron parsing (standard 5-field: minute hour day-of-month month day-of-week)

export interface ParsedCron {
	minutes: Set<number>;
	hours: Set<number>;
	days: Set<number>;
	months: Set<number>;
	weekdays: Set<number>;
	/** True when the day-of-month field is not `*` (affects day matching). */
	dayRestricted: boolean;
	weekdayRestricted: boolean;
}

function parseField(
	spec: string,
	fieldName: string,
	min: number,
	max: number,
	normalize: (n: number) => number = (n) => n
): { values: Set<number>; restricted: boolean } {
	const values = new Set<number>();
	let restricted = false;
	const fail = (why: string): never => {
		throw new ScheduleInputError(`Invalid cron ${fieldName} field "${spec}": ${why}`);
	};
	for (const item of spec.split(',')) {
		const match = item.match(/^(\*|\d+|\d+-\d+)(?:\/(\d+))?$/);
		if (!match) fail(`"${item}" is not a number, range, "*", or step`);
		const [, base, stepRaw] = match!;
		const step = stepRaw === undefined ? 1 : Number.parseInt(stepRaw, 10);
		if (step < 1) fail('step must be at least 1');

		let lo: number;
		let hi: number;
		if (base === '*') {
			lo = min;
			hi = max;
			if (stepRaw !== undefined) restricted = true;
		} else if (base.includes('-')) {
			const [a, b] = base.split('-').map((n) => Number.parseInt(n, 10));
			lo = a;
			hi = b;
			restricted = true;
		} else {
			lo = hi = Number.parseInt(base, 10);
			restricted = true;
			if (stepRaw !== undefined) fail('a step needs a range or "*" before the "/"');
		}
		if (lo < min || hi > max) fail(`values must be between ${min} and ${max}`);
		if (lo > hi) fail(`range ${lo}-${hi} is backwards`);
		for (let v = lo; v <= hi; v += step) values.add(normalize(v));
	}
	return { values, restricted };
}

/** Parses a 5-field cron expression, throwing ScheduleInputError when invalid. */
export function parseCron(expr: string): ParsedCron {
	const fields = expr.trim().split(/\s+/);
	if (fields.length !== 5) {
		throw new ScheduleInputError(
			`Cron expression "${expr.trim()}" must have 5 fields (minute hour day-of-month month day-of-week), got ${fields.length}`
		);
	}
	const [m, h, dom, mon, dow] = fields;
	const minutes = parseField(m, 'minute', 0, 59);
	const hours = parseField(h, 'hour', 0, 23);
	const days = parseField(dom, 'day-of-month', 1, 31);
	const months = parseField(mon, 'month', 1, 12);
	// 0 and 7 both mean Sunday, as in standard cron.
	const weekdays = parseField(dow, 'day-of-week', 0, 7, (n) => n % 7);
	return {
		minutes: minutes.values,
		hours: hours.values,
		days: days.values,
		months: months.values,
		weekdays: weekdays.values,
		dayRestricted: days.restricted,
		weekdayRestricted: weekdays.restricted
	};
}

/**
 * Validates a cron expression for use in a schedule: parseable, and firing
 * no more often than hourly. A single matching minute value means
 * consecutive firings are at least an hour apart; more than one means two
 * firings can land inside the same hour.
 */
export function validateScheduleCron(expr: string): ParsedCron {
	const parsed = parseCron(expr);
	if (parsed.minutes.size > 1) {
		throw new ScheduleInputError(
			`Cron expression "${expr.trim()}" would fire more often than once per hour; the minute field must be a single value`
		);
	}
	return parsed;
}

// ---------------------------------------------------------------------------
// Presets

export type PresetKind = 'hourly' | 'daily' | 'weekly' | 'monthly';

export interface SchedulePreset {
	kind: PresetKind;
	/** Time of day as "HH:MM" (24-hour); required for daily/weekly/monthly. */
	time?: string;
	/** 0 (Sunday) – 6 (Saturday); required for weekly. */
	weekday?: number;
	/** 1–31; required for monthly. */
	day_of_month?: number;
	/** 1–23; required for hourly ("every N hours"). */
	every_hours?: number;
	/** 0–59, minute past the hour for hourly; defaults to 0. */
	minute?: number;
}

export const WEEKDAY_NAMES = [
	'Sunday',
	'Monday',
	'Tuesday',
	'Wednesday',
	'Thursday',
	'Friday',
	'Saturday'
] as const;

function parseTimeOfDay(time: unknown): { hour: number; minute: number } {
	const match = typeof time === 'string' ? time.match(/^(\d{1,2}):(\d{2})$/) : null;
	if (match) {
		const hour = Number.parseInt(match[1], 10);
		const minute = Number.parseInt(match[2], 10);
		if (hour <= 23 && minute <= 59) return { hour, minute };
	}
	throw new ScheduleInputError(`Preset time must be "HH:MM" (24-hour), got "${String(time)}"`);
}

/** Compiles a preset to the cron expression evaluation reads. */
export function compilePreset(preset: SchedulePreset): string {
	if (preset.kind === 'hourly') {
		const every = preset.every_hours;
		if (typeof every !== 'number' || !Number.isInteger(every) || every < 1 || every > 23) {
			throw new ScheduleInputError('Hourly preset needs an every_hours between 1 and 23');
		}
		const minute = preset.minute ?? 0;
		if (typeof minute !== 'number' || !Number.isInteger(minute) || minute < 0 || minute > 59) {
			throw new ScheduleInputError('Hourly preset minute must be between 0 and 59');
		}
		// Cron semantics: */N restarts from hour 0 each day, so an N that
		// doesn't divide 24 has a shorter last interval before midnight.
		return every === 1 ? `${minute} * * * *` : `${minute} */${every} * * *`;
	}
	const { hour, minute } = parseTimeOfDay(preset.time);
	switch (preset.kind) {
		case 'daily':
			return `${minute} ${hour} * * *`;
		case 'weekly': {
			const weekday = preset.weekday;
			if (typeof weekday !== 'number' || !Number.isInteger(weekday) || weekday < 0 || weekday > 6) {
				throw new ScheduleInputError('Weekly preset needs a weekday between 0 (Sunday) and 6 (Saturday)');
			}
			return `${minute} ${hour} * * ${weekday}`;
		}
		case 'monthly': {
			const day = preset.day_of_month;
			if (typeof day !== 'number' || !Number.isInteger(day) || day < 1 || day > 31) {
				throw new ScheduleInputError('Monthly preset needs a day_of_month between 1 and 31');
			}
			return `${minute} ${hour} ${day} * *`;
		}
		default:
			throw new ScheduleInputError(
				`Unknown preset kind "${String((preset as { kind?: unknown }).kind)}"; expected hourly, daily, weekly, or monthly`
			);
	}
}

/** Human-readable recurrence, e.g. "Every Monday at 09:00". */
export function describeRecurrence(preset: SchedulePreset | null, cron: string): string {
	if (preset) {
		switch (preset.kind) {
			case 'hourly': {
				const every = preset.every_hours ?? 1;
				const at = preset.minute ? ` at :${String(preset.minute).padStart(2, '0')}` : '';
				return every === 1 ? `Every hour${at}` : `Every ${every} hours${at}`;
			}
			case 'daily':
				return `Every day at ${preset.time}`;
			case 'weekly':
				return `Every ${WEEKDAY_NAMES[preset.weekday ?? 0]} at ${preset.time}`;
			case 'monthly':
				return `Monthly on day ${preset.day_of_month} at ${preset.time}`;
		}
	}
	return `Cron “${cron}”`;
}

// ---------------------------------------------------------------------------
// Timezones

/** Throws ScheduleInputError unless tz is a timezone Intl recognizes. */
export function validateTimezone(tz: string): string {
	try {
		new Intl.DateTimeFormat('en-US', { timeZone: tz });
		return tz;
	} catch {
		throw new ScheduleInputError(`Unknown timezone "${tz}"; use an IANA name like "Europe/London"`);
	}
}

interface WallTime {
	year: number;
	month: number; // 1-12
	day: number; // 1-31
	hour: number;
	minute: number;
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function tzFormatter(tz: string): Intl.DateTimeFormat {
	let fmt = formatterCache.get(tz);
	if (!fmt) {
		fmt = new Intl.DateTimeFormat('en-US', {
			timeZone: tz,
			year: 'numeric',
			month: '2-digit',
			day: '2-digit',
			hour: '2-digit',
			minute: '2-digit',
			second: '2-digit',
			hourCycle: 'h23'
		});
		formatterCache.set(tz, fmt);
	}
	return fmt;
}

/** The wall-clock reading of a UTC instant in tz (seconds truncated). */
function wallTimeOf(utcMs: number, tz: string): WallTime {
	const parts: Record<string, number> = {};
	for (const p of tzFormatter(tz).formatToParts(utcMs)) {
		if (p.type !== 'literal') parts[p.type] = Number.parseInt(p.value, 10);
	}
	return {
		year: parts.year,
		month: parts.month,
		day: parts.day,
		// h23 keeps midnight as 0, but some engines report "24" for it.
		hour: parts.hour === 24 ? 0 : parts.hour,
		minute: parts.minute
	};
}

/** The instants (0, 1, or 2 of them, ascending) whose wall clock in tz reads w. */
function instantsOfWallTime(w: WallTime, tz: string): number[] {
	const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute);
	// Probe the UTC offset a day either side of the target: any DST transition
	// near it yields two distinct offsets, giving both fall-back candidates.
	const offsets = new Set<number>();
	for (const probe of [asUtc - 86_400_000, asUtc, asUtc + 86_400_000]) {
		const local = wallTimeOf(probe, tz);
		offsets.add(Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute) - probe);
	}
	const found: number[] = [];
	for (const offset of offsets) {
		const candidate = asUtc - offset;
		const local = wallTimeOf(candidate, tz);
		if (
			local.year === w.year &&
			local.month === w.month &&
			local.day === w.day &&
			local.hour === w.hour &&
			local.minute === w.minute &&
			!found.includes(candidate)
		) {
			found.push(candidate);
		}
	}
	return found.sort((a, b) => a - b);
}

function matchesDay(cron: ParsedCron, cal: Date): boolean {
	const dom = cron.days.has(cal.getUTCDate());
	const dow = cron.weekdays.has(cal.getUTCDay());
	// Standard cron: when both day fields are restricted, either may match.
	if (cron.dayRestricted && cron.weekdayRestricted) return dom || dow;
	if (cron.dayRestricted) return dom;
	if (cron.weekdayRestricted) return dow;
	return true;
}

/**
 * The first instant strictly after `afterMs` at which the cron expression
 * fires in tz. Wall-clock semantics across DST: a nonexistent local time
 * fires at the first valid instant after the gap; an ambiguous (repeated)
 * local time fires at its first instant. Throws ScheduleInputError if no
 * occurrence exists within ~5 years (e.g. an impossible date).
 */
export function nextOccurrence(cron: ParsedCron, tz: string, afterMs: number): number {
	const start = wallTimeOf(afterMs, tz);
	// Walk local wall-clock minutes on a fake-UTC calendar (Date.UTC used as
	// plain calendar arithmetic, no timezone meaning).
	const cal = new Date(Date.UTC(start.year, start.month - 1, start.day, start.hour, start.minute + 1));
	const limit = Date.UTC(start.year + 5, start.month - 1, start.day);
	let steps = 0;
	while (cal.getTime() < limit) {
		if (++steps > 400_000) break; // paranoia backstop; the limit check governs
		if (!cron.months.has(cal.getUTCMonth() + 1)) {
			cal.setUTCDate(1);
			cal.setUTCHours(0, 0, 0, 0);
			cal.setUTCMonth(cal.getUTCMonth() + 1);
			continue;
		}
		if (!matchesDay(cron, cal)) {
			cal.setUTCHours(0, 0, 0, 0);
			cal.setUTCDate(cal.getUTCDate() + 1);
			continue;
		}
		if (!cron.hours.has(cal.getUTCHours())) {
			cal.setUTCMinutes(0);
			cal.setUTCHours(cal.getUTCHours() + 1);
			continue;
		}
		if (!cron.minutes.has(cal.getUTCMinutes())) {
			cal.setUTCMinutes(cal.getUTCMinutes() + 1);
			continue;
		}

		// A local match. Map it to an instant; walk forward out of DST gaps.
		const probe = new Date(cal.getTime());
		for (let i = 0; i <= 25 * 60; i++) {
			const instants = instantsOfWallTime(
				{
					year: probe.getUTCFullYear(),
					month: probe.getUTCMonth() + 1,
					day: probe.getUTCDate(),
					hour: probe.getUTCHours(),
					minute: probe.getUTCMinutes()
				},
				tz
			);
			// Ambiguity (fall-back): the first instant. Skip instants at or
			// before afterMs — the same wall time can recur across a fold.
			const next = instants.find((t) => t > afterMs);
			if (next !== undefined) return next;
			if (instants.length > 0) break; // wall time exists but already passed
			probe.setUTCMinutes(probe.getUTCMinutes() + 1);
		}
		cal.setUTCMinutes(cal.getUTCMinutes() + 1);
	}
	throw new ScheduleInputError('The recurrence never fires (no matching date in the next 5 years)');
}

/** Convenience: parse + next occurrence in one call. */
export function nextOccurrenceFromCron(cronExpr: string, tz: string, afterMs: number): number {
	return nextOccurrence(parseCron(cronExpr), tz, afterMs);
}

// ---------------------------------------------------------------------------
// Template placeholders

export interface TemplateVars {
	date: string;
	time: string;
	datetime: string;
	schedule_name: string;
	count: string;
}

/** The placeholder values for an instance created at `atMs`, in the schedule's timezone. */
export function templateVars(scheduleName: string, count: number, tz: string, atMs: number): TemplateVars {
	const w = wallTimeOf(atMs, tz);
	const pad = (n: number) => String(n).padStart(2, '0');
	const date = `${w.year}-${pad(w.month)}-${pad(w.day)}`;
	const time = `${pad(w.hour)}:${pad(w.minute)}`;
	return {
		date,
		time,
		datetime: `${date} ${time}`,
		schedule_name: scheduleName,
		count: String(count)
	};
}

/**
 * Renders `{{date}}`-style placeholders (whitespace inside braces tolerated).
 * Unknown or malformed tokens are left as-is — they are probably literal
 * Markdown, and silently eating text is worse than rendering `{{oops}}`.
 */
export function renderTemplate(template: string, vars: TemplateVars): string {
	return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (token, key: string) =>
		Object.prototype.hasOwnProperty.call(vars, key) ? vars[key as keyof TemplateVars] : token
	);
}
