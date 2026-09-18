import type { IssueLinks, LinkedIssue } from '@tines/shared';

/**
 * An optimistic link operation still awaiting its own reload. Rendering is
 * always `server links + overlay`, so a reload triggered by one operation
 * can neither wipe a pending add nor resurrect a pending removal that
 * belongs to another still-in-flight operation.
 */
export interface PendingAdd {
	group: 'blocked_by' | 'blocks' | 'duplicate_of';
	entry: LinkedIssue;
}

/** Prefix of the placeholder link id an add carries until the server assigns one. */
export const TEMP_LINK_PREFIX = 'pending-';

export const isTempLink = (linkId: string) => linkId.startsWith(TEMP_LINK_PREFIX);

/**
 * The links to render: the server truth minus pending removals, plus
 * pending adds. Adds defer to a server row for the same issue (the add's
 * own reload has landed) and to pending removals (the row was removed
 * again before its add finished reconciling).
 */
export function mergeLinks(server: IssueLinks, adds: PendingAdd[], removals: string[]): IssueLinks {
	const removed = new Set(removals);
	const present = (l: LinkedIssue) => !removed.has(l.link_id);
	const merged: IssueLinks = {
		blocked_by: server.blocked_by.filter(present),
		blocks: server.blocks.filter(present),
		duplicate_of: server.duplicate_of && present(server.duplicate_of) ? server.duplicate_of : null,
		duplicated_by: server.duplicated_by.filter(present)
	};
	for (const { group, entry } of adds) {
		if (removed.has(entry.link_id)) continue;
		if (group === 'duplicate_of') {
			merged.duplicate_of ??= entry;
		} else if (!merged[group].some((l) => l.issue_id === entry.issue_id)) {
			merged[group] = [...merged[group], entry];
		}
	}
	return merged;
}
