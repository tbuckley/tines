import { sql, type Kysely } from 'kysely';
import type { Database } from '$lib/server/db';
import type { ActorContext } from './core';

/** Isolated E2E hook: change one authoritative predicate after service preflight. */
export function memberWriteRace(
	request: Request,
	db: Kysely<Database>,
	actor: ActorContext,
	issueId: string
): (() => Promise<void>) | undefined {
	if (import.meta.env.VITE_TINES_E2E !== '1') return;
	const action = request.headers.get('x-tines-e2e-member-write-race');
	if (!action) return;
	// A delegated run actor carries the owner's ID; the person is the member.
	const personId = actor.member?.userId ?? actor.userId;
	return async () => {
		switch (action) {
			case 'remove':
				await sql`UPDATE project_member SET revoked_at = ${Date.now()}, revision = revision + 1
				WHERE project_id = (SELECT project_id FROM issue WHERE id = ${issueId})
				AND user_id = ${personId} AND revoked_at IS NULL`.execute(db);
				break;
			case 'rejoin':
				// Removal then re-acceptance: a live membership at revision + 2.
				await sql`UPDATE project_member SET revision = revision + 2
				WHERE project_id = (SELECT project_id FROM issue WHERE id = ${issueId})
				AND user_id = ${personId} AND revoked_at IS NULL`.execute(db);
				break;
			case 'cancel-run':
				if (!actor.agentRunId) throw new Error('E2E cancel-run needs a run key');
				await sql`UPDATE agent_run SET cancel_requested_at = ${Date.now()}
				WHERE id = ${actor.agentRunId}`.execute(db);
				break;
			case 'expire-key':
				if (!actor.apiKeyId) throw new Error('E2E expire-key needs an API key');
				await sql`UPDATE api_key SET expires_at = ${Date.now() - 1}
				WHERE id = ${actor.apiKeyId}`.execute(db);
				break;
			case 'archive':
				await sql`UPDATE project SET archived_at = ${Date.now()}
				WHERE id = (SELECT project_id FROM issue WHERE id = ${issueId})`.execute(db);
				break;
			case 'hold':
				await sql`UPDATE issue SET agent_hold = 1, hold_revision = hold_revision + 1
				WHERE id = ${issueId}`.execute(db);
				break;
			case 'transfer': {
				const destination = request.headers.get('x-tines-e2e-member-race-target');
				if (!destination) throw new Error('Missing E2E transfer destination');
				await sql`UPDATE issue SET project_id = ${destination}, decision_revision = decision_revision + 1
				WHERE id = ${issueId}`.execute(db);
				break;
			}
			case 'workflow-reset':
				await sql`UPDATE workflow SET decision_revision = decision_revision + 1
				WHERE id = (SELECT workflow_id FROM issue WHERE id = ${issueId})`.execute(db);
				break;
			default:
				throw new Error('Unsupported E2E member write race');
		}
	};
}
