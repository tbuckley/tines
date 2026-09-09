import type { IssueListItem, Project } from '@tines/shared';
import { describe, expect, it } from 'vitest';
import { eligibleStarterIssue } from './starter-landing';

const project = { id: 'prj_1', archived_at: null, issue_count: 1 } as unknown as Project;
const issue = {
	id: 'iss_1',
	duplicate_of: null,
	active_run: null,
	created_at: 10,
	state_entered_at: 10,
	effective_state: { id: 'st_1', name: 'Scouting', category: 'active' }
} as unknown as IssueListItem;
const marker = { projectId: project.id, firstIssueId: issue.id };

describe('eligibleStarterIssue', () => {
	it('returns the untouched active first issue', () => {
		expect(
			eligibleStarterIssue(marker, project, [issue], { hasQuery: false, bounded: false })
		).toBe(issue);
	});

	it.each([
		['no marker', undefined, project, [issue], false, false],
		['wrong project', { ...marker, projectId: 'other' }, project, [issue], false, false],
		['archived', marker, { ...project, archived_at: 20 }, [issue], false, false],
		['query', marker, project, [issue], true, false],
		['bounded page', marker, project, [issue], false, true],
		['more issues', marker, { ...project, issue_count: 2 }, [issue], false, false],
		[
			'completed',
			marker,
			project,
			[{ ...issue, effective_state: { ...issue.effective_state, category: 'done' } }],
			false,
			false
		],
		['duplicate', marker, project, [{ ...issue, duplicate_of: {} }], false, false],
		['active run', marker, project, [{ ...issue, active_run: {} }], false, false],
		['returned state', marker, project, [{ ...issue, state_entered_at: 11 }], false, false]
	] as const)(
		'rejects %s',
		(_name, candidateMarker, candidateProject, issues, hasQuery, bounded) => {
			expect(
				eligibleStarterIssue(
					candidateMarker,
					candidateProject,
					issues as unknown as IssueListItem[],
					{
						hasQuery,
						bounded
					}
				)
			).toBeNull();
		}
	);
});
