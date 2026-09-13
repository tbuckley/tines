import type { IssueListItem, Project } from '@tines/shared';

export interface StarterLandingMarker {
	projectId: string;
	firstIssueId: string;
}

/** A one-visit hint is truthful only while the untouched starter issue is ready to begin. */
export function eligibleStarterIssue(
	marker: StarterLandingMarker | undefined,
	project: Project,
	issues: IssueListItem[],
	opts: { hasQuery: boolean; bounded: boolean }
): IssueListItem | null {
	if (
		!marker ||
		marker.projectId !== project.id ||
		project.archived_at !== null ||
		opts.hasQuery ||
		opts.bounded ||
		project.issue_count !== 1 ||
		issues.length !== 1
	)
		return null;
	const issue = issues[0];
	if (
		issue.id !== marker.firstIssueId ||
		issue.duplicate_of !== null ||
		issue.effective_state.category !== 'active' ||
		issue.active_run !== null ||
		issue.state_entered_at !== issue.created_at
	)
		return null;
	return issue;
}
