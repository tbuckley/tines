/**
 * Navigation memory: which list you were last looking at, and how it was
 * filtered. The issues list keeps its filters in the URL and nowhere else, so
 * every hardcoded `/issues` link used to throw them away. This remembers the
 * last `/issues` search string (for the Issues nav tab) and the last
 * issue-bearing list you visited (for an issue page's back link).
 *
 * Browser-only, `sessionStorage`-backed: per-tab, survives a reload, dies with
 * the tab. The URL stays the source of truth for what a list *shows* — this
 * only changes where links *point*.
 */
import { untrack } from 'svelte';

/** sessionStorage key. */
export const NAV_MEMORY_STORAGE_KEY = 'tines:nav-memory';

/** A list we can send someone back to: an in-app href plus its link text. */
export type ListMemory = { href: string; label: string };

export type NavMemory = {
	/** '' or '?…' — the last `/issues` search string. */
	issuesQuery: string;
	/** '' or '?…' — the last `/projects` search string (the archived toggle). */
	projectsQuery: string;
	/** The last issue-bearing list visited, or null before any. */
	lastList: ListMemory | null;
};

export const DEFAULT_NAV_MEMORY: NavMemory = { issuesQuery: '', projectsQuery: '', lastList: null };

/**
 * Only same-app list paths may be used as a back target, so a corrupt or
 * tampered stored value can never produce an external or protocol-relative
 * href.
 */
export function isListHref(value: unknown): value is string {
	if (typeof value !== 'string') return false;
	if (value.startsWith('//')) return false;
	return value === '/issues' || value.startsWith('/issues?') || value.startsWith('/projects/');
}

/** Missing, corrupt, or foreign values fall back to the default, per field. */
export function parseNavMemory(raw: string | null | undefined): NavMemory {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw ?? '');
	} catch {
		return DEFAULT_NAV_MEMORY;
	}
	if (typeof parsed !== 'object' || parsed === null) return DEFAULT_NAV_MEMORY;

	const { issuesQuery, projectsQuery, lastList } = parsed as Record<string, unknown>;
	const search = (value: unknown): string =>
		typeof value === 'string' && (value === '' || value.startsWith('?')) ? value : '';
	const query = search(issuesQuery);

	let list: ListMemory | null = null;
	if (typeof lastList === 'object' && lastList !== null) {
		const { href, label } = lastList as Record<string, unknown>;
		if (isListHref(href) && typeof label === 'string' && label !== '') list = { href, label };
	}

	return { issuesQuery: query, projectsQuery: search(projectsQuery), lastList: list };
}

/** Storage throws in Safari private mode and when cookies are blocked. */
function readStored(): NavMemory {
	if (typeof window === 'undefined') return DEFAULT_NAV_MEMORY;
	try {
		return parseNavMemory(sessionStorage.getItem(NAV_MEMORY_STORAGE_KEY));
	} catch {
		return DEFAULT_NAV_MEMORY;
	}
}

let memory = $state<NavMemory>(readStored());

/**
 * The recorders run inside a page's `$effect`, so the current value has to be
 * read untracked: a tracked read of state the same effect writes makes the
 * effect its own dependency, and Svelte aborts the flush (taking the rest of
 * the page's reactivity with it).
 */
function update(patch: Partial<NavMemory>): void {
	// The module-level state is shared across requests in the Worker isolate,
	// so it is only ever written in the browser.
	if (typeof window === 'undefined') return;
	const next = { ...untrack(() => memory), ...patch };
	memory = next;
	try {
		sessionStorage.setItem(NAV_MEMORY_STORAGE_KEY, JSON.stringify(next));
	} catch {
		// Unpersisted, but the links stay right for this navigation.
	}
}

export const navMemory = {
	/** Where the Issues nav tab should point. */
	get issuesHref(): string {
		return `/issues${memory.issuesQuery}`;
	},
	/** Where the Projects nav tab should point. */
	get projectsHref(): string {
		return `/projects${memory.projectsQuery}`;
	},
	get lastList(): ListMemory | null {
		return memory.lastList;
	},
	/** `search` is `page.url.search`: '' or '?…'. */
	recordIssues(search: string): void {
		update({ issuesQuery: search, lastList: { href: `/issues${search}`, label: 'Issues' } });
	},
	/**
	 * `search` is `page.url.search`. The grid is not an issue-bearing list, so
	 * this never touches `lastList`.
	 */
	recordProjects(search: string): void {
		update({ projectsQuery: search });
	},
	recordProject(projectId: string, search: string, name: string): void {
		update({ lastList: { href: `/projects/${projectId}${search}`, label: name } });
	}
};
