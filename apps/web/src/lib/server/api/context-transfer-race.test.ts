import { describe, expect, it } from 'vitest';
import { NOW, PROJECT, USER, addIssue, seedBase } from '../supervisor/test-fixtures';
import type { ActorContext } from './core';
import { createContextItem, updateContextItem } from './context';
import { createTestDb } from './test-db';

const DESTINATION = 'prj_context_destination';
const actor: ActorContext = {
	userId: USER,
	userName: 'alice',
	apiKeyId: null,
	apiKeyName: null,
	viaSession: true
};

function fixture() {
	const t = createTestDb();
	seedBase(t);
	t.sqlite.exec(`
		INSERT INTO project (id, user_id, name, created_at, updated_at)
		VALUES ('${DESTINATION}', '${USER}', 'destination', ${NOW}, ${NOW});
	`);
	const issueId = addIssue(t, { id: 'iss_context_race' });
	t.sqlite.exec(`
		INSERT INTO context_item (
			id, user_id, kind, name, description, project_id, issue_id, body,
			position, version, created_at, updated_at
		) VALUES (
			'ctx_context_race', '${USER}', 'prompt', 'directions', '', '${PROJECT}',
			'${issueId}', 'before', 4, 7, ${NOW}, ${NOW}
		);
	`);
	return { t, issueId };
}

function moveBeforeNextBatch(
	t: ReturnType<typeof fixture>['t'],
	issueId: string,
	{ moveContext = true } = {}
) {
	const realBatch = t.env.DB.batch.bind(t.env.DB);
	let first = true;
	t.env.DB.batch = async (statements) => {
		if (first) {
			first = false;
			t.sqlite.exec('BEGIN');
			try {
				t.sqlite.exec(`
					UPDATE issue SET project_id = '${DESTINATION}', number = 1,
						project_assignment_token = 'after-transfer' WHERE id = '${issueId}';
					${moveContext ? `UPDATE context_item SET project_id = '${DESTINATION}' WHERE issue_id = '${issueId}';` : ''}
				`);
				t.sqlite.exec('COMMIT');
			} catch (error) {
				t.sqlite.exec('ROLLBACK');
				throw error;
			}
		}
		return realBatch(statements);
	};
}

describe('context writes racing an issue transfer', () => {
	it('retries an omitted-scope edit on the transferred scope without restoring the source', async () => {
		const { t, issueId } = fixture();
		moveBeforeNextBatch(t, issueId);

		const updated = await updateContextItem(t.db, t.env, actor, 'ctx_context_race', {
			body: 'after'
		});

		expect(updated.body).toBe('after');
		expect(updated.version).toBe(8);
		expect(updated.position).toBe(4);
		expect(updated.scope.project_id).toBe(DESTINATION);
		expect(t.all(`SELECT project_id FROM context_item WHERE id = 'ctx_context_race'`)[0]).toEqual({
			project_id: DESTINATION
		});
	});

	it('rejects an explicit stale source scope after transfer', async () => {
		const { t, issueId } = fixture();
		moveBeforeNextBatch(t, issueId);

		await expect(
			updateContextItem(t.db, t.env, actor, 'ctx_context_race', {
				project_id: PROJECT,
				body: 'after'
			})
		).rejects.toMatchObject({ status: 422, code: 'scope_incoherent' });
		expect(
			t.all(`SELECT body, project_id, version FROM context_item WHERE id = 'ctx_context_race'`)[0]
		).toEqual({ body: 'before', project_id: DESTINATION, version: 7 });
	});

	it('maps a late source-scoped insert to a readable retryable error', async () => {
		const { t, issueId } = fixture();
		moveBeforeNextBatch(t, issueId, { moveContext: false });

		await expect(
			createContextItem(t.db, t.env, actor, {
				kind: 'prompt',
				name: 'late',
				body: 'late',
				project_id: PROJECT,
				issue_id: issueId
			})
		).rejects.toMatchObject({ status: 409, code: 'scope_incoherent' });
		expect(t.all(`SELECT * FROM context_item WHERE name = 'late'`)).toHaveLength(0);
	});
});
