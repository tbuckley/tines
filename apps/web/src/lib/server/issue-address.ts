import { sql, type RawBuilder } from 'kysely';

/** Allocate from the permanent namespace, never only from currently-owned issues. */
export function nextIssueNumber(projectId: string): RawBuilder<number> {
	return sql<number>`(SELECT COALESCE(MAX(number), 0) + 1 FROM issue_address WHERE project_id = ${projectId})`;
}
