import type { Actor } from '@tines/shared';

export function relativeTime(ms: number, now = Date.now()): string {
	const diff = now - ms;
	if (diff < 60_000) return 'just now';
	const minutes = Math.floor(diff / 60_000);
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	const days = Math.floor(hours / 24);
	if (days < 30) return `${days}d ago`;
	return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
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

/** "tbuckley" or "tbuckley via laptop-claude". */
export function actorLabel(actor: Actor): string {
	return actor.api_key_name ? `${actor.user_name} via ${actor.api_key_name}` : actor.user_name;
}

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
