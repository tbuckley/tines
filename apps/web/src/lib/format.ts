import type { AgentRun } from '@tines/shared';
import { isActiveRun } from '@tines/shared';

/** Absolute fallback for timestamps too far out to phrase as a duration. */
function shortDate(ms: number): string {
	return new Date(ms).toLocaleDateString(undefined, {
		month: 'short',
		day: 'numeric',
		year: 'numeric'
	});
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

/** Capacity elapsed since assignment, ticking only while a run is active. */
export function runElapsedLabel(
	run: Pick<AgentRun, 'status' | 'created_at' | 'ended_at'>,
	now: number
): string {
	const end = run.ended_at ?? (isActiveRun(run.status) ? now : null);
	if (end === null) return '—';
	const seconds = Math.floor(Math.max(0, end - run.created_at) / 1000);
	const hours = Math.floor(seconds / 3600);
	const minutes = Math.floor((seconds % 3600) / 60);
	const remainder = seconds % 60;
	return hours > 0
		? `${hours}:${minutes.toString().padStart(2, '0')}:${remainder.toString().padStart(2, '0')}`
		: `${minutes}:${remainder.toString().padStart(2, '0')}`;
}

/**
 * A queue wait, scannable in a row rather than phrased for prose: "41 min",
 * "1.9 h", "21 h", "8.2 d". Shared by the Now row and its annotations
 * (Tines/256), so a group and the roster row pointing at it never disagree.
 */
export function queueAge(enteredAt: number, now = Date.now()): string {
	const minutes = Math.max(0, Math.round((now - enteredAt) / 60_000));
	if (minutes < 60) return `${minutes} min`;
	const hours = minutes / 60;
	if (hours < 48) return `${hours < 10 ? hours.toFixed(1) : Math.round(hours)} h`;
	return `${(hours / 24).toFixed(1)} d`;
}

/**
 * relativeTime for a narrow column: "now", "5m", "3h", "2d". Past a month it
 * is the day ("Sep 4"), and only once the year differs does the year replace
 * the day ("Sep 2025") — the column has room for one or the other, not both.
 */
export function relativeTimeShort(ms: number, now = Date.now()): string {
	const diff = now - ms;
	if (diff < 60_000) return 'now';
	const minutes = Math.floor(diff / 60_000);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h`;
	const days = Math.floor(hours / 24);
	if (days < 30) return `${days}d`;
	const date = new Date(ms);
	return date.getFullYear() === new Date(now).getFullYear()
		? date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
		: date.toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
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

export type InvitationStatus = 'accepted' | 'canceled' | 'expired' | 'failed' | 'pending';

/**
 * What an invitation row means to the owner. Order matters: an accepted invite
 * later canceled by removing the member is still "accepted" (a member, not an
 * invite), and a failed delivery whose link has lapsed is "expired". Mirrors
 * the server's `expires_at <= now` test in invitationLanding.
 */
export function invitationStatus(
	invitation: {
		accepted_at: number | null;
		canceled_at: number | null;
		expires_at: number;
		delivery_status: string;
	},
	now = Date.now()
): InvitationStatus {
	if (invitation.accepted_at !== null) return 'accepted';
	if (invitation.canceled_at !== null) return 'canceled';
	if (invitation.expires_at <= now) return 'expired';
	if (invitation.delivery_status === 'failed') return 'failed';
	return 'pending';
}

/**
 * An invitation link's lifetime in words: "expires in 7 days" or "expired 2
 * hours ago". Rounds through hours so 23.6h reads "1 day", and treats
 * `expiresAt === now` as expired to agree with invitationStatus.
 */
export function invitationExpiryLabel(expiresAt: number, now = Date.now()): string {
	const diff = expiresAt - now;
	const span = durationWords(Math.abs(diff));
	return diff > 0 ? `expires in ${span}` : `expired ${span} ago`;
}

function durationWords(ms: number): string {
	const hours = Math.round(ms / 3_600_000);
	if (hours < 1) return 'under an hour';
	if (hours < 24) return hours === 1 ? '1 hour' : `${hours} hours`;
	const days = Math.round(hours / 24);
	return days === 1 ? '1 day' : `${days} days`;
}

/** A member's join day ("Sep 26"), with the year only when it is not this year. */
export function joinedDate(ms: number, now = Date.now()): string {
	const sameYear = new Date(ms).getFullYear() === new Date(now).getFullYear();
	return new Date(ms).toLocaleDateString(undefined, {
		month: 'short',
		day: 'numeric',
		...(sameYear ? {} : { year: 'numeric' })
	});
}

/** Date only, in the user's locale — for banners that name a day, not a moment. */
export function formatDate(ms: number): string {
	return new Date(ms).toLocaleString(undefined, {
		month: 'short',
		day: 'numeric',
		year: 'numeric'
	});
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

// Canonical attribution rendering (run-key aware).
export { actorLabel, compactActorLabel } from '@tines/shared';

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

/** CSS custom-property reference for a label palette key. */
export function labelColorVar(color: string): string {
	return `var(--label-${color}, var(--label-slate))`;
}

export function prefersReducedMotion(): boolean {
	return (
		typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
	);
}

/** Text color for a run status, shared by every run row rendering. */
export function runStatusClass(status: string): string {
	if (status === 'running' || status === 'launching')
		return 'text-emerald-600 dark:text-emerald-400';
	if (status === 'assigned') return 'text-sky-600 dark:text-sky-400';
	if (status === 'completed') return 'text-muted-foreground';
	return 'text-amber-700 dark:text-amber-400';
}

/** Clamps user- or URL-supplied text before it lands in a message. */
export function truncate(value: string, max = 60): string {
	return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}
