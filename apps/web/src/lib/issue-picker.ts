import type { Issue } from '@tines/shared';

/**
 * An issue chosen in `IssueCombobox`: enough to send its id, show what was
 * picked, and let the caller follow its project and workflow.
 */
export type IssuePick = Pick<
	Issue,
	'id' | 'number' | 'title' | 'project_id' | 'project_name' | 'workflow_id' | 'effective_state'
>;

type Candidate = IssuePick & Pick<Issue, 'duplicate_of'>;

/** The ref the app shows for an issue: `#12`, or `Tines/#12` when the picker spans projects. */
export const issueRef = (p: Pick<IssuePick, 'number' | 'project_name'>, withProject = false) =>
	withProject ? `${p.project_name}/#${p.number}` : `#${p.number}`;

/** What the user sees for a picked issue, and what the input shows after a pick. */
export const issueLabel = (
	p: Pick<IssuePick, 'number' | 'title' | 'project_name'>,
	withProject = false
) => `${issueRef(p, withProject)} ${p.title}`;

/**
 * Splits typed text into a title search and, for `#12` / `12` / `Tines/12` /
 * `Tines/#12`, the issue number (and project name) the user can see in the app.
 */
export function parseIssueQuery(text: string): {
	q: string;
	number: number | null;
	project: string | null;
} {
	const trimmed = text.trim();
	const match = /^(?:(.*\S)\s*\/\s*)?#?(\d+)$/.exec(trimmed);
	const parsed = match ? Number(match[2]) : null;
	const number = parsed !== null && Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
	return {
		q: trimmed.replace(/^#/, ''),
		number,
		project: number !== null ? (match?.[1] ?? null) : null
	};
}

/**
 * The project a typed `Project/N` names. Case is ignored, but an exact-case
 * match wins when two names differ only by case.
 */
export function findProjectByName<P extends { name: string }>(
	projects: P[],
	name: string
): P | undefined {
	const folded = name.toLowerCase();
	return (
		projects.find((p) => p.name === name) ?? projects.find((p) => p.name.toLowerCase() === folded)
	);
}

export type IssueOptionFilters = {
	limit?: number;
	/** Offer issues in a done state (sorted below the open ones). */
	includeDone?: boolean;
	/** Offer issues that are marked a duplicate. */
	includeDuplicates?: boolean;
	/** Issue ids never offered (e.g. the issue itself and what it already links to). */
	exclude?: Iterable<string>;
};

/**
 * Suggestions for the picker: an exact number hit first, then the search
 * results with open issues ahead of done ones, deduped by id and capped. The
 * exact hit comes from a direct lookup, so the done / duplicate filters the
 * search applied on the server are re-applied to it here.
 */
export function mergeIssueOptions(
	exact: Candidate | null,
	items: Candidate[],
	{
		limit = 8,
		includeDone = false,
		includeDuplicates = false,
		exclude = []
	}: IssueOptionFilters = {}
): IssuePick[] {
	const picks: IssuePick[] = [];
	const seen = new Set<string>(exclude);
	const isDone = (i: Candidate) => i.effective_state.category === 'done';
	const push = (i: Candidate) => {
		if (seen.has(i.id) || picks.length >= limit) return;
		if (!includeDone && isDone(i)) return;
		if (!includeDuplicates && i.duplicate_of !== null) return;
		seen.add(i.id);
		picks.push({
			id: i.id,
			number: i.number,
			title: i.title,
			project_id: i.project_id,
			project_name: i.project_name,
			workflow_id: i.workflow_id,
			effective_state: i.effective_state
		});
	};
	if (exact) push(exact);
	// Stable, so the server's order survives within each half.
	for (const item of [...items].sort((a, b) => Number(isDone(a)) - Number(isDone(b)))) push(item);
	return picks;
}
