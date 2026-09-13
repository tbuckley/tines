import type { UsageBy, UsageWindow } from '@tines/shared';

export type SpendWindow = UsageWindow | 'custom';
export type SpendSort = 'asc' | 'desc';

export interface SpendSelection {
	project: string;
	window: SpendWindow;
	view: UsageBy;
	workflow: string;
	sort: SpendSort;
	from: string;
	to: string;
	ready: boolean;
	requestKey: string;
	scope: string | null;
	kind: 'issues' | 'runs';
	member: string | null;
	population: 'finalized' | 'pending';
	evidenceSort: 'cost' | 'time';
	evidenceDirection: 'asc' | 'desc';
	cursor: string | null;
}

const windows = new Set<SpendWindow>(['today', '7d', '30d', 'custom']);
const views = new Set<UsageBy>(['workflow', 'state', 'outcome']);

export function patchSpendUrl(url: URL, changes: Record<string, string | null>): URL {
	const next = new URL(url);
	for (const [key, value] of Object.entries(changes)) {
		if (value === null) next.searchParams.delete(key);
		else next.searchParams.set(key, value);
	}
	return next;
}

export function parseSpendSelection(url: URL, focusId: string | null): SpendSelection {
	const rawWindow = url.searchParams.get('spend_window');
	const window: SpendWindow = windows.has(rawWindow as SpendWindow)
		? (rawWindow as SpendWindow)
		: '7d';
	const rawView = url.searchParams.get('spend_view');
	const view: UsageBy = views.has(rawView as UsageBy) ? (rawView as UsageBy) : 'workflow';
	const rawSort = url.searchParams.get('spend_sort');
	const sort: SpendSort = rawSort === 'asc' ? 'asc' : 'desc';
	const project = url.searchParams.get('spend_project') ?? focusId ?? 'all';
	const workflow = url.searchParams.get('spend_workflow') ?? 'all';
	const from = url.searchParams.get('spend_from') ?? '';
	const to = url.searchParams.get('spend_to') ?? '';
	const ready = window !== 'custom' || (from.trim() !== '' && to.trim() !== '');
	const scope = url.searchParams.get('spend_scope');
	const kind = url.searchParams.get('spend_kind') === 'runs' ? 'runs' : 'issues';
	const member = url.searchParams.get('spend_member');
	const population =
		url.searchParams.get('spend_population') === 'pending' ? 'pending' : 'finalized';
	const evidenceSort = url.searchParams.get('spend_evidence_sort') === 'time' ? 'time' : 'cost';
	const evidenceDirection = url.searchParams.get('spend_direction') === 'asc' ? 'asc' : 'desc';
	const cursor = url.searchParams.get('spend_cursor');
	const requestKey = JSON.stringify([
		project,
		workflow,
		view,
		window,
		window === 'custom' ? from : '',
		window === 'custom' ? to : ''
	]);
	return {
		project,
		window,
		view,
		workflow,
		sort,
		from,
		to,
		ready,
		requestKey,
		scope,
		kind,
		member,
		population,
		evidenceSort,
		evidenceDirection,
		cursor
	};
}

export function canonicalSpendChanges(url: URL, focusId: string | null) {
	const selection = parseSpendSelection(url, focusId);
	const changes: Record<string, string | null> = {};
	if (!url.searchParams.has('spend_project')) changes.spend_project = selection.project;
	if (!windows.has(url.searchParams.get('spend_window') as SpendWindow))
		changes.spend_window = selection.window;
	if (!views.has(url.searchParams.get('spend_view') as UsageBy))
		changes.spend_view = selection.view;
	if (url.searchParams.get('spend_sort') !== 'asc' && url.searchParams.get('spend_sort') !== 'desc')
		changes.spend_sort = selection.sort;
	if (!url.searchParams.has('spend_workflow')) changes.spend_workflow = selection.workflow;
	return changes;
}

export function spendRequest(selection: SpendSelection) {
	return {
		...(selection.window === 'custom'
			? { from: selection.from, to: selection.to }
			: { window: selection.window }),
		...(selection.project === 'all' ? {} : { project: selection.project }),
		...(selection.workflow === 'all' ? {} : { workflow: selection.workflow }),
		by: selection.view
	};
}

/**
 * A rejected `goto` leaves the address bar and the rendered view disagreeing,
 * so the Agents owner reports it with a Retry rather than swallowing it. The
 * current Agents loader does not read `url`, so a Spend query change makes no
 * `__data.json` request and cannot be failed from a browser test; this mapping
 * is therefore pinned here, and the assignment it feeds is covered by review.
 */
export function agentsNavigationMessage(error: unknown): string {
	return error instanceof Error && error.message
		? error.message
		: 'The requested Agents view could not be opened.';
}
