import { getDb } from '$lib/server/db';
import {
	inspectModerationSnapshot,
	listModerationAudit,
	listModerationReports
} from '$lib/server/publications/moderation';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, platform, params, url }) => {
	const db = getDb(platform!.env);
	const actor = {
		userId: locals.user!.id,
		userName: locals.user!.name,
		apiKeyId: null,
		apiKeyName: null,
		viaSession: true,
		agentRunId: null
	};
	const [snapshot, reports, audit] = await Promise.all([
		inspectModerationSnapshot(db, platform!.env, actor, params.snapshotId),
		listModerationReports(db, platform!.env, actor, params.snapshotId, {
			cursor: url.searchParams.get('reports_cursor') ?? undefined
		}),
		listModerationAudit(db, platform!.env, actor, params.snapshotId, {
			cursor: url.searchParams.get('audit_cursor') ?? undefined
		})
	]);
	return {
		...snapshot,
		reports: reports.items,
		reports_next_cursor: reports.next_cursor,
		audit: audit.items,
		audit_next_cursor: audit.next_cursor
	};
};
