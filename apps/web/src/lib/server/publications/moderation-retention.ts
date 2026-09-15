const BATCH_SIZE = 100;
const REPORT_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

export interface ModerationCleanupResult {
	deleted: number;
	passes: number;
}

/** Bounded, identity-free privacy cleanup, safe for cron and opportunistic traffic. */
export async function sweepModerationRetention(
	env: Env,
	now = Date.now(),
	maxPasses = 5
): Promise<ModerationCleanupResult> {
	let deleted = 0;
	let passes = 0;
	for (; passes < Math.min(5, Math.max(1, maxPasses)); passes++) {
		const statements = [
			env.DB.prepare(
				`DELETE FROM workflow_report_rate_event WHERE rowid IN
				 (SELECT rowid FROM workflow_report_rate_event WHERE expires_at <= ? LIMIT ${BATCH_SIZE})`
			).bind(now),
			env.DB.prepare(
				`DELETE FROM workflow_report_request WHERE rowid IN
				 (SELECT rowid FROM workflow_report_request WHERE expires_at <= ? LIMIT ${BATCH_SIZE})`
			).bind(now),
			env.DB.prepare(
				`DELETE FROM workflow_report WHERE id IN
				 (SELECT id FROM workflow_report WHERE resolved_at IS NOT NULL AND resolved_at <= ? LIMIT ${BATCH_SIZE})`
			).bind(now - REPORT_RETENTION_MS),
			env.DB.prepare(
				`DELETE FROM workflow_moderation_audit WHERE id IN
				 (SELECT id FROM workflow_moderation_audit WHERE expires_at <= ? LIMIT ${BATCH_SIZE})`
			).bind(now),
			env.DB.prepare(
				`DELETE FROM workflow_report_case WHERE snapshot_id IN
				 (SELECT c.snapshot_id FROM workflow_report_case c
				  WHERE c.version = c.resolved_through_version
				  AND NOT EXISTS (SELECT 1 FROM workflow_report r WHERE r.snapshot_id = c.snapshot_id)
				  LIMIT ${BATCH_SIZE})`
			)
		];
		const results = await env.DB.batch(statements);
		const changed = results.reduce((sum, result) => sum + Number(result.meta?.changes ?? 0), 0);
		deleted += changed;
		if (changed < BATCH_SIZE) break;
	}
	return { deleted, passes: passes + 1 };
}
