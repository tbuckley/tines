import { sql, type Kysely } from 'kysely';
import type { Database } from '$lib/server/db';

/** Called between building a shared run's launch material and its guarded mint. */
export type BeforeSharedMint = (
	db: Kysely<Database>,
	issueId: string,
	attempt: number
) => Promise<void>;

/**
 * Isolated E2E hook (`x-tines-e2e-bundle-race` on a runner poll): change the
 * shared guidance after the material was built and before the key is minted.
 * `<action>-once` races only the first attempt, so the rebuild admits;
 * `<action>-always` races every attempt, so the run is released.
 */
export function bundleRace(request: Request): BeforeSharedMint | undefined {
	if (import.meta.env.VITE_TINES_E2E !== '1') return;
	const header = request.headers.get('x-tines-e2e-bundle-race');
	if (!header) return;
	const match = /^(insert|edit|delete|rescope|journal)-(once|always)$/.exec(header);
	if (!match) throw new Error(`Unknown E2E bundle race: ${header}`);
	const [, action, when] = match;
	const target = request.headers.get('x-tines-e2e-bundle-race-item');
	return async (db, issueId, attempt) => {
		if (when === 'once' && attempt > 1) return;
		const now = Date.now();
		switch (action) {
			case 'insert':
				// A project-scoped prompt: shared automatically, so it now matches.
				await sql`INSERT INTO context_item
					(id, user_id, kind, name, description, project_id, body, position, version, created_at, updated_at)
					SELECT ${`ctx_race_${crypto.randomUUID().slice(0, 12)}`}, project.user_id, 'prompt',
						${`race-${attempt}-${now}`}, '', project.id, 'Raced guidance.', 0, 1, ${now}, ${now}
					FROM issue JOIN project ON project.id = issue.project_id
					WHERE issue.id = ${issueId}`.execute(db);
				break;
			case 'edit':
			case 'journal':
				if (!target) throw new Error('E2E bundle race needs x-tines-e2e-bundle-race-item');
				await sql`UPDATE context_item SET body = coalesce(body, '') || ${`\n- raced ${now}`},
					version = version + 1, updated_at = ${now} WHERE id = ${target}`.execute(db);
				break;
			case 'delete':
				if (!target) throw new Error('E2E bundle race needs x-tines-e2e-bundle-race-item');
				await sql`DELETE FROM context_item WHERE id = ${target}`.execute(db);
				break;
			case 'rescope': {
				// Into another test-owned project, never global: a global item would
				// leak into every later spec that reads the owner's library.
				const into = request.headers.get('x-tines-e2e-bundle-race-project');
				if (!target || !into)
					throw new Error('E2E bundle rescope needs x-tines-e2e-bundle-race-item and -project');
				await sql`UPDATE context_item SET project_id = ${into}, version = version + 1,
					updated_at = ${now} WHERE id = ${target}`.execute(db);
				break;
			}
		}
	};
}
