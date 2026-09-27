import type { Issue, IssueListItem } from '@tines/shared';

/** An issue chosen in `IssueCombobox`: enough to send its id and show what was picked. */
export type IssuePick = { id: string; number: number; title: string };

/** What the user sees for a picked issue, and what the input shows after a pick. */
export const issueLabel = (p: IssuePick) => `#${p.number} ${p.title}`;

/**
 * Splits typed text into a title search and, for `#12` / `12`, the issue
 * number the user can see in the app.
 */
export function parseIssueQuery(text: string): { q: string; number: number | null } {
	const trimmed = text.trim();
	const match = /^#?(\d+)$/.exec(trimmed);
	const number = match ? Number(match[1]) : null;
	return {
		q: trimmed.replace(/^#/, ''),
		number: number !== null && Number.isSafeInteger(number) && number > 0 ? number : null
	};
}

/**
 * Suggestions for the picker: an exact number hit first (only when it is still
 * open and not a duplicate, matching the search results), then the search
 * results, deduped by id and capped.
 */
export function mergeIssueOptions(
	exact: Pick<Issue, 'id' | 'number' | 'title' | 'effective_state' | 'duplicate_of'> | null,
	items: Pick<IssueListItem, 'id' | 'number' | 'title'>[],
	limit = 8
): IssuePick[] {
	const picks: IssuePick[] = [];
	const seen = new Set<string>();
	const push = (i: IssuePick) => {
		if (seen.has(i.id) || picks.length >= limit) return;
		seen.add(i.id);
		picks.push({ id: i.id, number: i.number, title: i.title });
	};
	if (exact && exact.effective_state.category !== 'done' && exact.duplicate_of === null)
		push(exact);
	for (const item of items) push(item);
	return picks;
}
