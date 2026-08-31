/** Absolute fallback for timestamps too far out to phrase as a duration. */
function shortDate(ms: number): string {
	return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

export function relativeTime(ms: number, now = Date.now()): string {
	const diff = now - ms;
	if (diff < 60_000) return 'just now';
	const minutes = Math.floor(diff / 60_000);
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	const days = Math.floor(hours / 24);
	if (days < 30) return `${days}d ago`;
	return shortDate(ms);
}

/**
 * Future counterpart of relativeTime: "in 5m", "in 3h", "in 2d".
 *
 * A timestamp already in the past reads as overdue ("3h overdue"), never as an
 * imminent countdown — a schedule whose next run has stopped advancing has to
 * look stalled rather than perpetually about to fire.
 */
export function untilTime(ms: number, now = Date.now()): string {
	const diff = ms - now;
	if (diff < 0) return overdueTime(ms, -diff);
	if (diff < 60_000) return 'in <1m';
	const minutes = Math.round(diff / 60_000);
	if (minutes < 60) return `in ${minutes}m`;
	const hours = Math.round(minutes / 60);
	if (hours < 24) return `in ${hours}h`;
	const days = Math.round(hours / 24);
	if (days < 30) return `in ${days}d`;
	return shortDate(ms);
}

/**
 * The past side of untilTime. Within a minute of the due time it is "due now":
 * the sweep only fires every few minutes, so being seconds late is routine and
 * should not read as a fault.
 */
function overdueTime(ms: number, late: number): string {
	if (late < 60_000) return 'due now';
	const minutes = Math.round(late / 60_000);
	if (minutes < 60) return `${minutes}m overdue`;
	const hours = Math.round(minutes / 60);
	if (hours < 24) return `${hours}h overdue`;
	const days = Math.round(hours / 24);
	if (days < 30) return `${days}d overdue`;
	return `overdue since ${shortDate(ms)}`;
}

/**
 * A schedule's next-run line. Pending runs carry the "next" prefix ("next in
 * 5m"); once past due the phrase stands alone, since "next 3h overdue" reads
 * backwards.
 */
export function nextRunLabel(nextRunAt: number, now = Date.now()): string {
	const until = untilTime(nextRunAt, now);
	return nextRunAt >= now ? `next ${until}` : until;
}

export function formatDateTime(ms: number): string {
	return new Date(ms).toLocaleString(undefined, {
		month: 'short',
		day: 'numeric',
		year: 'numeric',
		hour: 'numeric',
		minute: '2-digit'
	});
}

// Canonical "alice via …" attribution rendering (run-key aware).
export { actorLabel } from '@tines/shared';

// The one description of what an activity event says, shared with the CLI.
export { describeEvent, displayActor, eventSummary } from '@tines/shared';

export const CATEGORY_LABELS: Record<string, string> = {
	backlog: 'Backlog',
	active: 'Active',
	awaiting_human: 'Awaiting human',
	done: 'Done'
};

/** CSS custom-property reference for a category's color. */
export function categoryVar(category: string): string {
	return `var(--cat-${category}, var(--cat-backlog))`;
}

export function prefersReducedMotion(): boolean {
	return (
		typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
	);
}

/** Text color for a run status, shared by every run row rendering. */
export function runStatusClass(status: string): string {
	if (status === 'running' || status === 'launching') return 'text-emerald-600 dark:text-emerald-400';
	if (status === 'assigned') return 'text-sky-600 dark:text-sky-400';
	if (status === 'completed') return 'text-muted-foreground';
	return 'text-amber-700 dark:text-amber-400';
}

/** Clamps user- or URL-supplied text before it lands in a message. */
export function truncate(value: string, max = 60): string {
	return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}
