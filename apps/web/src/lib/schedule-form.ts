import {
	compilePreset,
	describeRecurrence,
	nextOccurrenceFromCron,
	ScheduleInputError,
	validateScheduleCron,
	type CreateScheduleInput,
	type Schedule,
	type SchedulePreset
} from '@tines/shared';
import { formatDateTime } from '$lib/format';

/** The state behind the Repeat form (New Issue modal + schedule edit modal). */
export interface RepeatFormState {
	kind: 'never' | 'hourly' | 'daily' | 'weekly' | 'monthly' | 'cron';
	/** "HH:MM", 24-hour (daily/weekly/monthly). */
	time: string;
	/** 0 (Sunday) – 6 (Saturday); weekly. */
	weekday: number;
	/** 1–31; monthly. */
	dayOfMonth: number;
	/** 1–23; hourly ("every N hours"). */
	everyHours: number;
	/** 0–59, minute past the hour; hourly. */
	minute: number;
	/** Raw 5-field expression; custom cron. */
	cron: string;
	timezone: string;
	requireAllClosed: boolean;
}

export function browserTimezone(): string {
	try {
		return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
	} catch {
		return 'UTC';
	}
}

export function defaultRepeatState(): RepeatFormState {
	return {
		kind: 'never',
		time: '09:00',
		weekday: 1,
		dayOfMonth: 1,
		everyHours: 1,
		minute: 0,
		cron: '0 9 * * 1',
		timezone: browserTimezone(),
		requireAllClosed: false
	};
}

/** The recurrence part of the form as API input; null when kind is "never". */
export function repeatToScheduleInput(state: RepeatFormState): CreateScheduleInput | null {
	switch (state.kind) {
		case 'never':
			return null;
		case 'cron':
			return { cron: state.cron, timezone: state.timezone, require_all_closed: state.requireAllClosed };
		default: {
			const preset: SchedulePreset =
				state.kind === 'hourly'
					? { kind: 'hourly', every_hours: state.everyHours, minute: state.minute }
					: {
							kind: state.kind,
							time: state.time,
							...(state.kind === 'weekly' ? { weekday: state.weekday } : {}),
							...(state.kind === 'monthly' ? { day_of_month: state.dayOfMonth } : {})
						};
			return { preset, timezone: state.timezone, require_all_closed: state.requireAllClosed };
		}
	}
}

/** Seeds the form from an existing schedule (the edit modal). */
export function repeatFromSchedule(schedule: Schedule): RepeatFormState {
	const base = defaultRepeatState();
	base.timezone = schedule.timezone;
	base.requireAllClosed = schedule.require_all_closed;
	base.cron = schedule.cron;
	if (!schedule.preset) {
		base.kind = 'cron';
		return base;
	}
	base.kind = schedule.preset.kind;
	if (schedule.preset.time !== undefined) base.time = schedule.preset.time;
	if (schedule.preset.weekday !== undefined) base.weekday = schedule.preset.weekday;
	if (schedule.preset.day_of_month !== undefined) base.dayOfMonth = schedule.preset.day_of_month;
	if (schedule.preset.every_hours !== undefined) base.everyHours = schedule.preset.every_hours;
	if (schedule.preset.minute !== undefined) base.minute = schedule.preset.minute;
	return base;
}

/**
 * The live summary line ("Every Monday at 09:00, Europe/London — next:
 * Aug 25, 9:00 AM"), or the validation error for an invalid recurrence.
 */
export function repeatSummary(state: RepeatFormState): { ok: boolean; text: string } {
	if (state.kind === 'never') return { ok: true, text: '' };
	try {
		const input = repeatToScheduleInput(state)!;
		const cron = input.preset ? compilePreset(input.preset) : input.cron!;
		validateScheduleCron(cron);
		const next = nextOccurrenceFromCron(cron, state.timezone, Date.now());
		return {
			ok: true,
			text: `${describeRecurrence(input.preset ?? null, cron)}, ${state.timezone} — next: ${formatDateTime(next)}`
		};
	} catch (e) {
		return { ok: false, text: e instanceof ScheduleInputError ? e.message : 'Invalid recurrence' };
	}
}

/** Timezone options for the picker; the current value is kept in the list. */
export function timezoneOptions(current: string): string[] {
	let zones: string[] = [];
	try {
		zones = Intl.supportedValuesOf('timeZone');
	} catch {
		zones = ['UTC'];
	}
	if (!zones.includes(current)) zones = [current, ...zones];
	return zones;
}
